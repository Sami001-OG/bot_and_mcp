import { Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { TradingViewSignalSchema, type ExchangeId, type TradingViewSignal } from '@platform/contracts';
import { createExchangeAdapter, runReadOnlyCertification } from '@platform/exchange-adapters';
import { ExchangeError, type MarketInfo } from '@platform/exchange-core';
import { TradingViewWebhookVerifier } from '@platform/webhook';
import { encryption, prisma, Prisma, type ExchangeAccount, type OrderIntent } from '@platform/database';
import { hashToken } from '@platform/security';
import { CommandError, OrdersQueue, cancelOrderCommand, closeAllCommand, createBot, createWebhookEndpoint, decryptCredentials, getBot, listBots, listExchangeMarkets, listLedgerPositions, listWebhookEndpoints, listWorkspaceOrders, parseOrderBody, placeOrder, portfolioPositions, portfolioSummary, realizedPnlInWindow, setBotStatus, updateBotConfig } from '@platform/commands';
import { AuthController } from './auth.controller.js';
import { AuthGuard, WorkspaceGuard, type AuthedRequest } from './guards.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const ordersQueue = OrdersQueue.connect(redis);
const webhooksQueue = new Queue('webhooks', { connection: redis });

const REQUIRE_WEBHOOK_SIGNATURE = (process.env.WEBHOOK_REQUIRE_SIGNATURE ?? 'true').toLowerCase() !== 'false';

const MARKETS_CACHE_TTL_MS = 10 * 60 * 1000;
const marketsCache = new Map<string, { expiresAt: number; data: MarketInfo[] }>();

export const SUPPORTED_EXCHANGES = ['bybit'] as const;
export type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

function toHttpException(error: unknown): HttpException {
  if (error instanceof CommandError) {
    const payload: Record<string, unknown> = { message: error.message, code: error.code };
    if (error.details) Object.assign(payload, error.details);
    return new HttpException(payload, error.statusCode);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new HttpException({ message: 'Duplicate request' }, HttpStatus.CONFLICT);
  }
  if (error instanceof HttpException) return error;
  throw error;
}

async function certifyAccount(account: ExchangeAccount): Promise<{ passed: boolean; checks: import('@platform/exchange-adapters').CertificationCheck[]; serverTimeSkewMs?: number; durationMs: number; credentialVersion: number }> {
  const credential = await prisma.exchangeCredential.findFirst({ where: { exchangeAccountId: account.id, revokedAt: null }, orderBy: { version: 'desc' } });
  if (!credential) throw new ExchangeError('NO_CREDENTIAL', `${account.label} has no active credential`, false);
  const adapter = createExchangeAdapter(account.exchange.toLowerCase() as ExchangeId, account.marketType);
  try {
    const startedAt = Date.now();
    const result = await runReadOnlyCertification(adapter, decryptCredentials(credential));
    const durationMs = Date.now() - startedAt;
    const run = await prisma.certificationRun.create({ data: { exchangeAccountId: account.id, credentialVersion: credential.version, status: result.passed ? 'PASS' : 'FAIL', checks: result.checks as unknown as Prisma.InputJsonValue, durationMs, completedAt: new Date() } });
    return { passed: result.passed, checks: result.checks, ...(result.serverTimeSkewMs === undefined ? {} : { serverTimeSkewMs: result.serverTimeSkewMs }), durationMs: run.durationMs, credentialVersion: credential.version };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

function orderToResponse(order: OrderIntent) {
  return { id: order.id, exchangeAccountId: order.exchangeAccountId, symbol: order.symbol, side: order.side, positionSide: order.positionSide, marketType: order.marketType, type: order.orderType, quantity: order.quantity.toString(), price: order.price?.toString(), stopPrice: order.stopPrice?.toString(), leverage: order.leverage, marginMode: order.marginMode, allocation: order.allocation ?? undefined, reduceOnly: order.reduceOnly, postOnly: order.postOnly, clientOrderId: order.clientOrderId, idempotencyKey: order.idempotencyKey, state: order.state, rejectionReason: order.rejectionReason, exchangeOrderId: order.exchangeOrderId, createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString() };
}

@ApiTags('health')
@Controller('health')
class HealthController {
  @Get()
  async health() {
    let postgres = 'down';
    let redisStatus = 'down';
    try { await prisma.$queryRaw`SELECT 1`; postgres = 'up'; } catch { /* unreachable */ }
    try { redisStatus = (await redis.ping()) === 'PONG' ? 'up' : 'down'; } catch { /* unreachable */ }
    return { status: postgres === 'up' && redisStatus === 'up' ? 'ok' : 'degraded', service: 'api', time: new Date().toISOString(), dependencies: { postgres, redis: redisStatus } };
  }
}

@ApiTags('exchange-accounts')
@Controller('exchange-accounts')
@UseGuards(AuthGuard, WorkspaceGuard)
class ExchangeAccountsController {
  @Post()
  async create(@Req() request: AuthedRequest, @Body() body: { exchange: string; marketType: string; label: string; apiKey: string; secret: string; passphrase?: string }) {
    const normalizedExchange = body.exchange.toLowerCase();
    if (!(SUPPORTED_EXCHANGES as readonly string[]).includes(normalizedExchange)) {
      throw new HttpException(`Exchange not supported yet. Supported exchanges: ${SUPPORTED_EXCHANGES.join(', ')}`, HttpStatus.BAD_REQUEST);
    }
    if (!body.apiKey || !body.secret) {
      throw new HttpException('apiKey and secret are required', HttpStatus.BAD_REQUEST);
    }
    const exchange = normalizedExchange.toUpperCase() as ExchangeAccount['exchange'];
    const marketType = body.marketType as ExchangeAccount['marketType'];
    const workspaceId = request.user.workspaceId;
    try {
      createExchangeAdapter(normalizedExchange as ExchangeId, marketType);
    } catch (error) {
      throw new HttpException(error instanceof Error ? error.message : 'Unsupported exchange or market type', HttpStatus.BAD_REQUEST);
    }
    const account = await prisma.exchangeAccount.create({ data: { workspaceId, exchange, marketType, label: body.label, tradingEnabled: false } });
    const credential = await prisma.exchangeCredential.create({ data: { exchangeAccountId: account.id, version: 1, keyId: hashToken(body.apiKey).slice(0, 16), encryptedPayload: encryption.encrypt(JSON.stringify({ apiKey: body.apiKey, secret: body.secret, ...(body.passphrase ? { passphrase: body.passphrase } : {}) }), `exchange-credential:${account.id}`), fingerprint: hashToken(body.apiKey), permissions: [], status: 'PENDING' } });
    let certificationStatus = 'FAIL';
    try {
      const { passed } = await certifyAccount(account);
      if (passed) {
        certificationStatus = 'VERIFIED';
        await prisma.exchangeCredential.update({ where: { id: credential.id }, data: { status: 'VERIFIED', permissions: ['read', 'trade'] } });
        await prisma.exchangeAccount.update({ where: { id: account.id }, data: { credentialStatus: 'VERIFIED', lastConnectedAt: new Date() } });
      } else {
        await prisma.exchangeCredential.update({ where: { id: credential.id }, data: { status: 'FAILED' } });
        await prisma.exchangeAccount.update({ where: { id: account.id }, data: { credentialStatus: 'FAILED' } });
      }
    } catch {
      await prisma.exchangeCredential.update({ where: { id: credential.id }, data: { status: 'FAILED' } }).catch(() => undefined);
      await prisma.exchangeAccount.update({ where: { id: account.id }, data: { credentialStatus: 'FAILED' } }).catch(() => undefined);
    }
    const final = await prisma.exchangeAccount.findUniqueOrThrow({ where: { id: account.id } });
    return { id: account.id, exchange, marketType, label: account.label, tradingEnabled: final.tradingEnabled, credentialStatus: final.credentialStatus, verified: final.credentialStatus === 'VERIFIED', certificationStatus, note: final.credentialStatus === 'VERIFIED' ? 'Read-only certification passed.' : 'Certification failed (network or invalid keys). Re-verify once the network allows access.' };
  }

  @Get()
  async list(@Req() request: AuthedRequest) {
    const workspaceId = request.user.workspaceId;
    const accounts = await prisma.exchangeAccount.findMany({ where: { workspaceId }, include: { credentials: { select: { status: true, version: true, permissions: true } }, _count: { select: { orders: true } } }, orderBy: { createdAt: 'asc' } });
    return accounts.map((account) => ({ id: account.id, exchange: account.exchange, marketType: account.marketType, label: account.label, tradingEnabled: account.tradingEnabled, credentialStatus: account.credentialStatus, lastConnectedAt: account.lastConnectedAt?.toISOString() ?? null, orderCount: account._count.orders, credentials: account.credentials }));
  }

  @Post(':id/verify')
  async verify(@Req() request: AuthedRequest, @Param('id') id: string) {
    const account = await prisma.exchangeAccount.findFirst({ where: { id, workspaceId: request.user.workspaceId } });
    if (!account) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    try {
      const result = await certifyAccount(account);
      if (result.passed) {
        await prisma.exchangeCredential.updateMany({ where: { exchangeAccountId: id, revokedAt: null }, data: { status: 'VERIFIED', permissions: ['read', 'trade'] } });
        await prisma.exchangeAccount.update({ where: { id }, data: { credentialStatus: 'VERIFIED', lastConnectedAt: new Date() } });
      } else {
        await prisma.exchangeCredential.updateMany({ where: { exchangeAccountId: id, revokedAt: null }, data: { status: 'FAILED' } });
        await prisma.exchangeAccount.update({ where: { id }, data: { credentialStatus: 'FAILED' } });
      }
      return { id, credentialStatus: result.passed ? 'VERIFIED' : 'FAILED', connected: result.passed, checks: result.checks, durationMs: result.durationMs, credentialVersion: result.credentialVersion };
    } catch (error) {
      await prisma.exchangeCredential.updateMany({ where: { exchangeAccountId: id }, data: { status: 'FAILED' } });
      await prisma.exchangeAccount.update({ where: { id }, data: { credentialStatus: 'FAILED' } });
      return { id, credentialStatus: 'FAILED', connected: false, error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error) };
    }
  }

  @Get(':id/certifications')
  async certifications(@Req() request: AuthedRequest, @Param('id') id: string) {
    const account = await prisma.exchangeAccount.findFirst({ where: { id, workspaceId: request.user.workspaceId }, select: { id: true } });
    if (!account) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    const runs = await prisma.certificationRun.findMany({ where: { exchangeAccountId: id }, orderBy: { startedAt: 'desc' }, take: 50 });
    return runs.map((run) => ({ id: run.id, status: run.status, checks: run.checks, credentialVersion: run.credentialVersion, durationMs: run.durationMs, startedAt: run.startedAt.toISOString() }));
  }

  @Post(':id/acknowledge')
  async acknowledge(@Req() request: AuthedRequest, @Param('id') id: string) {
    const account = await prisma.exchangeAccount.findFirst({ where: { id, workspaceId: request.user.workspaceId } });
    if (!account) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    if (account.credentialStatus !== 'VERIFIED') throw new HttpException('Account must be verified before live trading can be enabled', HttpStatus.CONFLICT);
    const [workspace, updated] = await prisma.$transaction([
      prisma.workspace.update({
        where: { id: request.user.workspaceId },
        data: { liveTradingEnabled: true, liveTradingAcknowledgedAt: new Date() }
      }),
      prisma.exchangeAccount.update({ where: { id: account.id }, data: { tradingEnabled: true } })
    ]);
    return { id: account.id, tradingEnabled: updated.tradingEnabled, workspaceLiveTradingEnabled: workspace.liveTradingEnabled, acknowledgedAt: workspace.liveTradingAcknowledgedAt?.toISOString() ?? null };
  }

  @Post(':id/disable-trading')
  async disableTrading(@Req() request: AuthedRequest, @Param('id') id: string) {
    const account = await prisma.exchangeAccount.findFirst({ where: { id, workspaceId: request.user.workspaceId } });
    if (!account) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    const updated = await prisma.exchangeAccount.update({ where: { id }, data: { tradingEnabled: false } });
    return { id, tradingEnabled: updated.tradingEnabled };
  }

  @Get(':id/markets')
  async markets(@Req() request: AuthedRequest, @Param('id') id: string, @Query('quote') quote?: string) {
    const account = await prisma.exchangeAccount.findFirst({ where: { id, workspaceId: request.user.workspaceId } });
    if (!account) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    const cacheKey = `${id}:${(quote ?? '*').toUpperCase()}`;
    const cached = marketsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { accountId: id, cached: true, quote: quote ?? '*', count: cached.data.length, markets: cached.data };
    try {
      const markets = await listExchangeMarkets(account, quote);
      marketsCache.set(cacheKey, { expiresAt: Date.now() + MARKETS_CACHE_TTL_MS, data: markets });
      return { accountId: id, cached: false, quote: quote ?? '*', count: markets.length, markets };
    } catch (error) {
      throw toHttpException(error);
    }
  }
}

@ApiTags('orders')
@Controller('orders')
@UseGuards(AuthGuard, WorkspaceGuard)
class OrdersController {
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async place(@Req() request: AuthedRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    try {
      const result = await placeOrder({
        workspaceId: request.user.workspaceId,
        request: parseOrderBody(body, key),
        enqueue: (orderId) => ordersQueue.enqueueExecute(orderId)
      });
      if (!result.accepted) {
        return { accepted: false, state: result.state, id: result.id, duplicate: true, order: result.order ? orderToResponse(result.order) : undefined };
      }
      return { accepted: true, state: result.state, id: result.id, order: orderToResponse(result.order), risk: result.risk, marketPrice: result.marketPrice, ...(result.sized ? { sized: result.sized } : {}), queuedAt: result.queuedAt };
    } catch (error) {
      throw toHttpException(error);
    }
  }

  @Get()
  async list(@Req() request: AuthedRequest) {
    const workspaceId = request.user.workspaceId;
    const orders = await prisma.orderIntent.findMany({ where: { workspaceId }, include: { exchangeAccount: { select: { exchange: true, label: true } }, executions: true }, orderBy: { createdAt: 'desc' }, take: 50 });
    return orders.map((order) => ({ ...orderToResponse(order), executions: order.executions.map((execution) => ({ id: execution.id, exchangeExecutionId: execution.exchangeExecutionId, quantity: execution.quantity.toString(), price: execution.price.toString(), fee: execution.fee.toString(), feeAsset: execution.feeAsset, executedAt: execution.executedAt.toISOString() })) }));
  }

  @Get(':id')
  async get(@Req() request: AuthedRequest, @Param('id') id: string) {
    const workspaceId = request.user.workspaceId;
    const order = await prisma.orderIntent.findFirst({ where: { id, workspaceId }, include: { executions: true } });
    if (!order) throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
    return { ...orderToResponse(order), executions: order.executions.map((execution) => ({ id: execution.id, exchangeExecutionId: execution.exchangeExecutionId, quantity: execution.quantity.toString(), price: execution.price.toString(), fee: execution.fee.toString(), feeAsset: execution.feeAsset, executedAt: execution.executedAt.toISOString() })) };
  }

  @Post(':id/cancel')
  @HttpCode(202)
  async cancel(@Req() request: AuthedRequest, @Param('id') id: string) {
    try {
      return await cancelOrderCommand({ workspaceId: request.user.workspaceId, orderId: id, enqueue: (orderId) => ordersQueue.enqueueCancel(orderId) });
    } catch (error) {
      throw toHttpException(error);
    }
  }

  @Post('emergency/close-all')
  @HttpCode(202)
  async closeAll(@Req() request: AuthedRequest, @Body() body: { exchangeAccountId?: string }) {
    try {
      return await closeAllCommand({ workspaceId: request.user.workspaceId, ...(body.exchangeAccountId ? { exchangeAccountId: body.exchangeAccountId } : {}), enqueue: (exchangeAccountId) => ordersQueue.enqueueCloseAll(exchangeAccountId) });
    } catch (error) {
      throw toHttpException(error);
    }
  }
}

@ApiTags('portfolio')
@Controller('portfolio')
@UseGuards(AuthGuard, WorkspaceGuard)
class PortfolioController {
  @Get('summary')
  async summary(@Req() request: AuthedRequest) {
    return portfolioSummary(request.user.workspaceId);
  }

  @Get('positions')
  async positions(@Req() request: AuthedRequest) {
    return portfolioPositions(request.user.workspaceId);
  }

  @Get('orders')
  async orders(@Req() request: AuthedRequest) {
    const orders = await listWorkspaceOrders(request.user.workspaceId, 100);
    return orders.map(orderToResponse);
  }

  @Get('pnl')
  async pnl(@Req() request: AuthedRequest, @Query('since') since?: string) {
    const workspaceId = request.user.workspaceId;
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const positions = await listLedgerPositions(workspaceId);
    const realized = await realizedPnlInWindow(workspaceId, sinceDate);
    const realizedTotal = realized.reduce((sum, row) => sum + Number(row.realizedPnl), 0);
    const open = positions.filter((position) => Number(position.quantity) !== 0);
    const unrealizedTotal = open
      .filter((position) => position.side === 'LONG' || position.side === 'SHORT')
      .reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
    return {
      windowStart: sinceDate.toISOString(),
      positions,
      realized,
      totals: {
        unrealizedPnl: String(unrealizedTotal),
        realizedPnl: String(realizedTotal),
        openPositions: open.length,
        ledgerRows: positions.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  @Get('executions')
  async executions(@Req() request: AuthedRequest, @Query('take') take?: string) {
    const orders = await listWorkspaceOrders(request.user.workspaceId, Number(take) || 50);
    const rows: Array<{ orderId: string; state: string; side: string; positionSide: string; symbol: string; exchange: string; label: string; executionId: string | null; quantity: string; price: string; fee: string; feeAsset: string | null; executedAt: string | null; createdAt: string }> = [];
    for (const order of orders) {
      if (order.executions.length === 0) {
        rows.push({ orderId: order.id, state: order.state, side: order.side, positionSide: order.positionSide, symbol: order.symbol, exchange: order.exchangeAccount.exchange, label: order.exchangeAccount.label, executionId: null, quantity: order.quantity.toString(), price: '', fee: '', feeAsset: null, executedAt: null, createdAt: order.createdAt.toISOString() });
        continue;
      }
      for (const execution of order.executions) {
        rows.push({ orderId: order.id, state: order.state, side: order.side, positionSide: order.positionSide, symbol: order.symbol, exchange: order.exchangeAccount.exchange, label: order.exchangeAccount.label, executionId: execution.exchangeExecutionId, quantity: execution.quantity.toString(), price: execution.price.toString(), fee: execution.fee.toString(), feeAsset: execution.feeAsset, executedAt: execution.executedAt.toISOString(), createdAt: order.createdAt.toISOString() });
      }
    }
    rows.sort((a, b) => (b.executedAt ?? b.createdAt).localeCompare(a.executedAt ?? a.createdAt));
    return rows;
  }
}

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(AuthGuard, WorkspaceGuard)
class WebhooksController {
  @Post()
  async create(@Req() request: AuthedRequest, @Body() body: { name: string }) {
    return createWebhookEndpoint({ workspaceId: request.user.workspaceId, name: body.name });
  }

  @Get()
  async list(@Req() request: AuthedRequest) {
    return listWebhookEndpoints(request.user.workspaceId);
  }
}

@ApiTags('webhooks')
@Controller('webhooks/tradingview')
class WebhookIngressController {
  @Post(':endpointId')
  @HttpCode(202)
  async receive(@Req() request: Request, @Param('endpointId') endpointId: string, @Body() body: unknown, @Headers('x-tradingview-signature') signature?: string) {
    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId }, include: { workspace: { select: { liveTradingEnabled: true } } } });
    if (!endpoint) throw new HttpException('Webhook endpoint not found', HttpStatus.NOT_FOUND);
    if (!endpoint.active) throw new HttpException('Webhook endpoint is disabled', HttpStatus.FORBIDDEN);
    if (!endpoint.workspace.liveTradingEnabled) throw new HttpException('Live trading is disabled for this workspace', HttpStatus.FORBIDDEN);
    let signal: TradingViewSignal;
    if (signature) {
      const secret = encryption.decrypt(endpoint.encryptedSigningSecret as { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string; keyId: string }, `webhook-endpoint:${endpoint.workspaceId}`);
      const verifier = new TradingViewWebhookVerifier(secret, { claim: async (key, ttlSeconds) => (await redis.set(`wh:replay:${endpointId}:${key}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK' });
      const raw = (request as { rawBody?: Buffer }).rawBody?.toString() ?? JSON.stringify(body ?? {});
      try {
        signal = await verifier.verify(raw, signature);
      } catch (error) {
        throw new HttpException(error instanceof Error ? error.message : 'Invalid webhook', HttpStatus.UNAUTHORIZED);
      }
    } else {
      if (REQUIRE_WEBHOOK_SIGNATURE) throw new HttpException('Webhook signature required (x-tradingview-signature header)', HttpStatus.UNAUTHORIZED);
      signal = TradingViewSignalSchema.parse(body);
    }
    try {
      const delivery = await prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, nonce: signal.nonce, payloadHash: hashToken(JSON.stringify(body)), status: 'PENDING' } });
      await webhooksQueue.add('process', { deliveryId: delivery.id, endpointId: endpoint.id, signal }, { jobId: delivery.id, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
      return { accepted: true, endpointId, deliveryId: delivery.id, receivedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.webhookDelivery.findUnique({ where: { endpointId_nonce: { endpointId: endpoint.id, nonce: signal.nonce } } });
        throw new HttpException({ message: 'Duplicate webhook (nonce already processed)', deliveryId: existing?.id }, HttpStatus.CONFLICT);
      }
      throw error;
    }
  }
}

@ApiTags('bots')
@Controller('bots')
@UseGuards(AuthGuard, WorkspaceGuard)
class BotsController {
  @Get()
  async list(@Req() request: AuthedRequest) {
    return listBots(request.user.workspaceId);
  }

  @Post()
  async create(@Req() request: AuthedRequest, @Body() body: { name: string; exchangeAccountId: string; config: unknown }) {
    try {
      return await createBot({ workspaceId: request.user.workspaceId, userId: request.user.userId, name: body.name, exchangeAccountId: body.exchangeAccountId, config: body.config });
    } catch (error) {
      throw toHttpException(error);
    }
  }

  @Get(':id')
  async get(@Req() request: AuthedRequest, @Param('id') id: string) {
    try {
      return await getBot(request.user.workspaceId, id);
    } catch (error) {
      throw toHttpException(error);
    }
  }

  @Patch(':id/config')
  async updateConfig(@Req() request: AuthedRequest, @Param('id') id: string, @Body() body: { config: unknown }) {
    try {
      return await updateBotConfig({ workspaceId: request.user.workspaceId, userId: request.user.userId, botId: id, config: body.config });
    } catch (error) {
      throw toHttpException(error);
    }
  }

  @Post(':id/pause') async pause(@Req() request: AuthedRequest, @Param('id') id: string) { return this.setStatus(request, id, 'PAUSED'); }
  @Post(':id/resume') async resume(@Req() request: AuthedRequest, @Param('id') id: string) { return this.setStatus(request, id, 'ACTIVE'); }
  @Post(':id/stop') async stop(@Req() request: AuthedRequest, @Param('id') id: string) { return this.setStatus(request, id, 'STOPPED'); }
  private async setStatus(request: AuthedRequest, id: string, status: 'PAUSED' | 'ACTIVE' | 'STOPPED') {
    try {
      return await setBotStatus({ workspaceId: request.user.workspaceId, botId: id, status });
    } catch (error) {
      throw toHttpException(error);
    }
  }
}

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard, WorkspaceGuard)
class NotificationsController {
  @Get()
  async list(@Req() request: AuthedRequest) {
    return prisma.notification.findMany({ where: { workspaceId: request.user.workspaceId }, orderBy: [{ createdAt: 'desc' }], take: 100 });
  }

  @Get('unread/count')
  async unreadCount(@Req() request: AuthedRequest) {
    const count = await prisma.notification.count({ where: { workspaceId: request.user.workspaceId, readAt: null } });
    return { count };
  }

  @Post(':id/read')
  async read(@Req() request: AuthedRequest, @Param('id') id: string) {
    const notification = await prisma.notification.findFirst({ where: { id, workspaceId: request.user.workspaceId } });
    if (!notification) throw new HttpException('Notification not found', HttpStatus.NOT_FOUND);
    if (notification.readAt) return { id, status: 'already-read' };
    await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    return { id, status: 'read' };
  }

  @Post('read-all')
  async readAll(@Req() request: AuthedRequest) {
    const result = await prisma.notification.updateMany({ where: { workspaceId: request.user.workspaceId, readAt: null }, data: { readAt: new Date() } });
    return { updated: result.count };
  }
}

@WebSocketGateway({ namespace: '/realtime', cors: { origin: true, credentials: true } })
class RealtimeGateway {
  @WebSocketServer() server!: Server;
  @SubscribeMessage('subscribe') subscribe(@MessageBody() body: { topics: string[] }) { return { event: 'subscribed', data: { topics: body.topics, sequence: '0' } }; }
}

@Module({ controllers: [HealthController, AuthController, ExchangeAccountsController, OrdersController, PortfolioController, WebhooksController, WebhookIngressController, BotsController, NotificationsController], providers: [RealtimeGateway] })
export class AppModule {}
