import { Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Module, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { OrderRequestSchema, TradingViewSignalSchema, WebhookBotConfigSchema, type ExchangeId, type ResolvedOrderRequest, type TradingViewSignal } from '@platform/contracts';
import { evaluateOrder } from '@platform/risk-engine';
import type { RiskPolicy as RiskPolicyType } from '@platform/risk-engine';
import { createExchangeAdapter, runReadOnlyCertification } from '@platform/exchange-adapters';
import { ExchangeError } from '@platform/exchange-core';
import { sizeOrder } from '@platform/trading-core';
import { TradingViewWebhookVerifier } from '@platform/webhook';
import { encryption, prisma, Prisma, type ExchangeAccount, type OrderIntent } from '@platform/database';
import { hashToken } from '@platform/security';
import { AuthController } from './auth.controller.js';
import { AuthGuard, WorkspaceGuard, type AuthedRequest } from './guards.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const ordersQueue = new Queue('orders', { connection: redis });
const webhooksQueue = new Queue('webhooks', { connection: redis });

export const SUPPORTED_EXCHANGES = ['binance', 'bybit'] as const;
export type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

const defaultPolicy: RiskPolicyType = { maxDailyLoss: '1000', maxWeeklyLoss: '3000', maxMonthlyLoss: '10000', maxDrawdownPercent: '20', maxConcurrentPositions: 10, maxExposure: '100000', maxLeverage: 20, maxRiskPerTrade: '500', maxPositionSize: '25000', consecutiveLossCooldown: 3, tradingEnabled: true };

async function loadPolicy(workspaceId: string): Promise<RiskPolicyType> {
  const row = await prisma.riskPolicy.findUnique({ where: { workspaceId } });
  if (!row) return defaultPolicy;
  return { maxDailyLoss: row.maxDailyLoss.toString(), maxWeeklyLoss: row.maxWeeklyLoss.toString(), maxMonthlyLoss: row.maxMonthlyLoss.toString(), maxDrawdownPercent: row.maxDrawdownPercent.toString(), maxConcurrentPositions: row.maxConcurrentPositions, maxExposure: row.maxExposure.toString(), maxLeverage: row.maxLeverage, maxRiskPerTrade: row.maxRiskPerTrade.toString(), maxPositionSize: row.maxPositionSize.toString(), consecutiveLossCooldown: row.consecutiveLossCooldown, tradingEnabled: row.tradingEnabled };
}

function decryptCredentials(credential: { exchangeAccountId: string; encryptedPayload: Prisma.JsonValue }): { apiKey: string; secret: string; passphrase?: string } {
  const payload = JSON.parse(encryption.decrypt(credential.encryptedPayload as { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string; keyId: string }, `exchange-credential:${credential.exchangeAccountId}`)) as { apiKey: string; secret: string; passphrase?: string };
  return payload;
}

async function latestCredential(accountId: string) {
  return prisma.exchangeCredential.findFirst({ where: { exchangeAccountId: accountId, revokedAt: null }, orderBy: { version: 'desc' } });
}

async function connectAccount(account: ExchangeAccount) {
  const credential = await latestCredential(account.id);
  if (!credential) throw new ExchangeError('NO_CREDENTIAL', `${account.label} has no active credential`, false);
  const adapter = createExchangeAdapter(account.exchange.toLowerCase() as ExchangeId, account.marketType);
  try {
    const connection = await adapter.connect(decryptCredentials(credential));
    return { adapter, connection, credential };
  } catch (error) {
    await adapter.disconnect().catch(() => undefined);
    throw error;
  }
}

async function resolveMarketSnapshot(account: ExchangeAccount, symbol: string, requestPrice?: string): Promise<{ price: string; equity: string; maxEquity: string }> {
  const { adapter } = await connectAccount(account);
  try {
    const price = requestPrice ?? await adapter.getPrice(symbol);
    const balances = await adapter.getBalance();
    const quote = symbol.split('/')[1] ?? 'USDT';
    const equity = balances.find((balance) => balance.asset === quote)?.free ?? '0';
    const previousEquity = account.equity === null ? undefined : account.equity.toString();
    const previousPeak = account.peakEquity === null ? undefined : account.peakEquity.toString();
    const peakEquity = previousPeak === undefined ? (previousEquity === undefined ? equity : previousEquity) : Prisma.Decimal.max(previousPeak, equity).toString();
    await prisma.exchangeAccount.update({ where: { id: account.id }, data: { equity: new Prisma.Decimal(equity), peakEquity: new Prisma.Decimal(peakEquity) } });
    return { price, equity, maxEquity: peakEquity };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

async function certifyAccount(account: ExchangeAccount): Promise<{ passed: boolean; checks: import('@platform/exchange-adapters').CertificationCheck[]; serverTimeSkewMs?: number; durationMs: number; credentialVersion: number }> {
  const credential = await latestCredential(account.id);
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
}

@ApiTags('orders')
@Controller('orders')
@UseGuards(AuthGuard, WorkspaceGuard)
class OrdersController {
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async place(@Req() request: AuthedRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const parsed = OrderRequestSchema.parse({ ...(body as object), idempotencyKey: key });
    const workspaceId = request.user.workspaceId;
    const account = await prisma.exchangeAccount.findUnique({ where: { id: parsed.exchangeAccountId } });
    if (!account || account.workspaceId !== workspaceId) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    if (!account.tradingEnabled) throw new HttpException('Trading is disabled for this exchange account', HttpStatus.CONFLICT);
    if (account.marketType !== parsed.marketType) throw new HttpException(`Account is ${account.marketType}, request is ${parsed.marketType}`, HttpStatus.BAD_REQUEST);
    const isLeveraged = account.marketType !== 'SPOT';
    if (isLeveraged && parsed.marginMode && parsed.marginMode !== 'ISOLATED') throw new HttpException('Only ISOLATED margin mode is supported', HttpStatus.BAD_REQUEST);
    const marginMode = isLeveraged ? 'ISOLATED' : undefined;
    let market: { price: string; equity: string; maxEquity: string };
    try {
      market = await resolveMarketSnapshot(account, parsed.symbol, parsed.price);
    } catch (error) {
      throw new HttpException({ message: 'Could not resolve live market data for this order', details: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error) }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    let effective: ResolvedOrderRequest;
    if (parsed.allocation) {
      const allocation = parsed.allocation;
      const sized = sizeOrder({ allocation, marketType: parsed.marketType, price: market.price, equity: market.equity, maxEquity: market.maxEquity, ...(parsed.leverage == null ? {} : { leverage: parsed.leverage }), ...(parsed.stopPrice ? { stopPrice: parsed.stopPrice } : {}) });
      if (!sized.ok || sized.quantity === undefined) throw new HttpException({ message: 'Order rejected by sizing engine', reasons: sized.reasons, allocation }, HttpStatus.CONFLICT);
      effective = { ...parsed, quantity: sized.quantity, leverage: sized.leverage };
      market = { ...market, equity: market.equity };
    } else {
      effective = parsed as ResolvedOrderRequest;
    }
    const policy = await loadPolicy(workspaceId);
    const risk = evaluateOrder(effective, policy, { equity: market.equity, dailyPnl: '0', weeklyPnl: '0', monthlyPnl: '0', peakEquity: market.maxEquity, exposure: '0', openPositions: 0, consecutiveLosses: 0, markPrice: market.price });
    if (!risk.approved) throw new HttpException({ message: 'Order rejected by risk engine', risk, allocation: parsed.allocation }, HttpStatus.CONFLICT);
    try {
      const order = await prisma.orderIntent.create({ data: { workspaceId, exchangeAccountId: account.id, idempotencyKey: key ?? '', clientOrderId: parsed.clientOrderId, symbol: parsed.symbol, side: parsed.side, positionSide: parsed.positionSide, orderType: parsed.type, marketType: parsed.marketType, quantity: new Prisma.Decimal(effective.quantity), ...(parsed.price ? { price: new Prisma.Decimal(parsed.price) } : {}), ...(parsed.stopPrice ? { stopPrice: new Prisma.Decimal(parsed.stopPrice) } : {}), ...(effective.leverage ? { leverage: effective.leverage } : {}), ...(marginMode ? { marginMode } : {}), ...(parsed.allocation ? { allocation: parsed.allocation as unknown as Prisma.InputJsonValue } : {}), reduceOnly: parsed.reduceOnly, postOnly: parsed.postOnly, state: 'QUEUED' } });
      await ordersQueue.add('execute', { action: 'execute', orderId: order.id }, { jobId: order.id, attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
      return { accepted: true, state: 'QUEUED', id: order.id, order: orderToResponse(order), risk, marketPrice: market.price, sized: parsed.allocation ? { quantity: effective.quantity, notional: new Prisma.Decimal(effective.quantity).mul(market.price).toDecimalPlaces(4).toFixed(), leverage: effective.leverage } : undefined, queuedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.orderIntent.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: key ?? '' } } });
        return { accepted: false, state: existing?.state ?? 'DUPLICATE', id: existing?.id, duplicate: true, order: existing ? orderToResponse(existing) : undefined };
      }
      throw error;
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
    const workspaceId = request.user.workspaceId;
    const order = await prisma.orderIntent.findFirst({ where: { id, workspaceId } });
    if (!order) throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
    if (!['QUEUED', 'ACKNOWLEDGED', 'SUBMITTING', 'PARTIALLY_FILLED'].includes(order.state)) throw new HttpException(`Order is ${order.state} and cannot be canceled`, HttpStatus.CONFLICT);
    await prisma.orderIntent.update({ where: { id }, data: { state: 'CANCEL_PENDING' } });
    await ordersQueue.add('cancel', { action: 'cancel', orderId: id }, { jobId: `cancel:${id}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
    return { accepted: true, orderId: id, state: 'CANCEL_PENDING' };
  }

  @Post('emergency/close-all')
  @HttpCode(202)
  async closeAll(@Req() request: AuthedRequest, @Body() body: { exchangeAccountId?: string }) {
    const workspaceId = request.user.workspaceId;
    const where = { workspaceId, ...(body.exchangeAccountId ? { id: body.exchangeAccountId } : {}) };
    const accounts = await prisma.exchangeAccount.findMany({ where });
    if (accounts.length === 0) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    for (const account of accounts) {
      await ordersQueue.add('close-all', { action: 'close-all', exchangeAccountId: account.id }, { jobId: `close-all:${account.id}:${Date.now()}` });
    }
    return { accepted: true, operation: 'CLOSE_ALL_POSITIONS', exchangeAccountIds: accounts.map((account) => account.id), queuedAt: new Date().toISOString() };
  }
}

@ApiTags('portfolio')
@Controller('portfolio')
@UseGuards(AuthGuard, WorkspaceGuard)
class PortfolioController {
  @Get('summary')
  async summary(@Req() request: AuthedRequest) {
    const workspaceId = request.user.workspaceId;
    const accounts = await prisma.exchangeAccount.findMany({ where: { workspaceId } });
    const totals: Record<string, { free: string; locked: string }> = {};
    const accountSummaries = await Promise.all(accounts.map(async (account) => {
      try {
        const { adapter, connection } = await connectAccount(account);
        try {
          const [balances, positions] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
          for (const balance of balances) {
            totals[balance.asset] = { free: String(Number(totals[balance.asset]?.free ?? 0) + Number(balance.free)), locked: String(Number(totals[balance.asset]?.locked ?? 0) + Number(balance.locked)) };
          }
          const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
          return { accountId: account.id, exchange: account.exchange, marketType: account.marketType, label: account.label, status: 'connected', serverTime: connection.serverTime, balances, positions, unrealizedPnl: String(unrealizedPnl) };
        } finally {
          await adapter.disconnect().catch(() => undefined);
        }
      } catch (error) {
        return { accountId: account.id, exchange: account.exchange, marketType: account.marketType, label: account.label, status: 'unreachable', error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error) };
      }
    }));
    const orderCount = await prisma.orderIntent.count({ where: { workspaceId } });
    return { totalValue: 'N/A (spot balances aggregated)', balances: Object.entries(totals).map(([asset, value]) => ({ asset, ...value })), accounts: accountSummaries, totalOrderCount: orderCount, generatedAt: new Date().toISOString() };
  }

  @Get('positions')
  async positions(@Req() request: AuthedRequest) {
    const workspaceId = request.user.workspaceId;
    const accounts = await prisma.exchangeAccount.findMany({ where: { workspaceId } });
    const results = await Promise.all(accounts.map(async (account) => {
      try {
        const { adapter } = await connectAccount(account);
        try {
          const positions = await adapter.getPositions();
          return { accountId: account.id, label: account.label, status: 'connected', positions };
        } finally {
          await adapter.disconnect().catch(() => undefined);
        }
      } catch (error) {
        return { accountId: account.id, label: account.label, status: 'unreachable', error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error) };
      }
    }));
    return results;
  }

  @Get('orders')
  async orders(@Req() request: AuthedRequest) {
    const workspaceId = request.user.workspaceId;
    const orders = await prisma.orderIntent.findMany({ where: { workspaceId }, include: { executions: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    return orders.map(orderToResponse);
  }
}

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(AuthGuard, WorkspaceGuard)
class WebhooksController {
  @Post()
  async create(@Req() request: AuthedRequest, @Body() body: { name: string }) {
    const workspaceId = request.user.workspaceId;
    const token = `wh_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    const signingSecret = crypto.randomUUID();
    const endpoint = await prisma.webhookEndpoint.create({ data: { workspaceId, name: body.name, tokenHash: hashToken(token), encryptedSigningSecret: encryption.encrypt(signingSecret, `webhook-endpoint:${workspaceId}`) } });
    return { id: endpoint.id, name: endpoint.name, token, signingSecret, url: `POST /api/v1/webhooks/tradingview/${endpoint.id}` };
  }

  @Get()
  async list(@Req() request: AuthedRequest) {
    const workspaceId = request.user.workspaceId;
    return prisma.webhookEndpoint.findMany({ where: { workspaceId }, include: { _count: { select: { deliveries: true } } } });
  }
}

@ApiTags('webhooks')
@Controller('webhooks/tradingview')
class WebhookIngressController {
  @Post(':endpointId')
  @HttpCode(202)
  async receive(@Req() request: Request, @Param('endpointId') endpointId: string, @Body() body: unknown, @Headers('x-tradingview-signature') signature?: string) {
    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint) throw new HttpException('Webhook endpoint not found', HttpStatus.NOT_FOUND);
    if (!endpoint.active) throw new HttpException('Webhook endpoint is disabled', HttpStatus.FORBIDDEN);
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
    const workspaceId = request.user.workspaceId;
    return prisma.bot.findMany({ where: { workspaceId }, include: { exchangeAccount: { select: { exchange: true, label: true } } }, orderBy: { createdAt: 'desc' } });
  }

  @Post()
  async create(@Req() request: AuthedRequest, @Body() body: { name: string; exchangeAccountId: string; config: unknown }) {
    const workspaceId = request.user.workspaceId;
    const config = WebhookBotConfigSchema.parse(body.config);
    const account = await prisma.exchangeAccount.findFirst({ where: { id: body.exchangeAccountId, workspaceId } });
    if (!account) throw new HttpException('Exchange account not found', HttpStatus.NOT_FOUND);
    if (account.credentialStatus !== 'VERIFIED') throw new HttpException('Exchange account must be VERIFIED before attaching a bot', HttpStatus.CONFLICT);
    if (!account.tradingEnabled) throw new HttpException('Trading is not enabled for this exchange account', HttpStatus.CONFLICT);
    const checksum = hashToken(JSON.stringify(config));
    const bot = await prisma.$transaction(async (tx) => {
      const created = await tx.bot.create({ data: { workspaceId, exchangeAccountId: account.id, name: body.name, type: 'WEBHOOK', status: 'ACTIVE', activeVersion: 1, config } });
      await tx.botVersion.create({ data: { botId: created.id, version: 1, config, checksum, createdBy: request.user.userId } });
      return created;
    });
    return bot;
  }

  @Get(':id')
  async get(@Req() request: AuthedRequest, @Param('id') id: string) {
    const workspaceId = request.user.workspaceId;
    const bot = await prisma.bot.findFirst({ where: { id, workspaceId }, include: { exchangeAccount: { select: { exchange: true, label: true, marketType: true } }, versions: { orderBy: { version: 'desc' } }, runs: { orderBy: { startedAt: 'desc' }, take: 20 } } });
    if (!bot) throw new HttpException('Bot not found', HttpStatus.NOT_FOUND);
    return bot;
  }

  @Patch(':id/config')
  async updateConfig(@Req() request: AuthedRequest, @Param('id') id: string, @Body() body: { config: unknown }) {
    const workspaceId = request.user.workspaceId;
    const bot = await prisma.bot.findFirst({ where: { id, workspaceId } });
    if (!bot) throw new HttpException('Bot not found', HttpStatus.NOT_FOUND);
    const config = WebhookBotConfigSchema.parse(body.config);
    const nextVersion = bot.activeVersion + 1;
    const checksum = hashToken(JSON.stringify(config));
    const updated = await prisma.$transaction(async (tx) => {
      await tx.botVersion.create({ data: { botId: bot.id, version: nextVersion, config, checksum, createdBy: request.user.userId } });
      return tx.bot.update({ where: { id: bot.id }, data: { config, activeVersion: nextVersion } });
    });
    return updated;
  }

  @Post(':id/pause') async pause(@Req() request: AuthedRequest, @Param('id') id: string) { return this.setStatus(request, id, 'PAUSED'); }
  @Post(':id/resume') async resume(@Req() request: AuthedRequest, @Param('id') id: string) { return this.setStatus(request, id, 'ACTIVE'); }
  @Post(':id/stop') async stop(@Req() request: AuthedRequest, @Param('id') id: string) { return this.setStatus(request, id, 'STOPPED'); }
  private async setStatus(request: AuthedRequest, id: string, status: 'PAUSED' | 'ACTIVE' | 'STOPPED') {
    const workspaceId = request.user.workspaceId;
    const bot = await prisma.bot.findFirst({ where: { id, workspaceId } });
    if (!bot) throw new HttpException('Bot not found', HttpStatus.NOT_FOUND);
    if (bot.status === status) return { id, status };
    await prisma.bot.update({ where: { id }, data: { status } });
    return { id, status };
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
