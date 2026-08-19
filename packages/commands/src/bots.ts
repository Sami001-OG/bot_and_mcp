import { randomUUID } from 'node:crypto';
import { WebhookBotConfigSchema, TradingViewSignalSchema, type PositionSide, type ResolvedOrderRequest, type TradingViewSignal, type WebhookBotConfig } from '@platform/contracts';
import { prisma, Prisma, type Bot } from '@platform/database';
import { buildWebhookOrders } from '@platform/bot-engine';
import { hashToken } from '@platform/security';
import { evaluateOrder, type RiskPolicy } from '@platform/risk-engine';
import { TradingViewWebhookVerifier, type ReplayStore } from '@platform/webhook';
import { CommandError } from './errors.js';
import { connectToAccount, getAccountConfig, marketPrecisionOf } from './account.js';
import { checkCircuitBreaker } from './ledger.js';
import { getSettings, requireTradingEnabled } from './settings.js';
import { executeOrderNow, persistOrder, type ExecuteResult } from './execute.js';
import { loadPolicy } from './orders.js';
import { queueNotification } from './notifications.js';
import { manageBotPositions, mergeManagementOverrides, type ManageResult } from './manage.js';
import type { ManagementOverrides } from '@platform/contracts';

export type CreateBotInput = { name: string; exchangeAccountId: string; config: unknown; password?: string };

export async function createBot(input: CreateBotInput) {
  const { name, exchangeAccountId } = input;
  await requireTradingEnabled();
  const account = await prisma.exchangeAccount.findUnique({ where: { id: exchangeAccountId }, select: { id: true } });
  if (!account) throw new CommandError(404, 'ACCOUNT_NOT_FOUND', 'Exchange account not found');
  const config = WebhookBotConfigSchema.parse(input.config);
  const checksum = hashToken(JSON.stringify(config));
  const password = input.password?.trim() ?? '';
  if (password.length > 0 && password.length < 12) {
    throw new CommandError(400, 'PASSWORD_TOO_SHORT', "Bot password must be at least 12 characters (it authenticates the bot's webhook and MCP)");
  }
  const signingSecret = password.length >= 12 ? password : randomUUID();
  const endpoint = await prisma.webhookEndpoint.create({ data: { name: `${name} (bot webhook)`, signingSecret } });
  let bot: Bot | undefined;
  try {
    bot = await prisma.bot.create({
      data: { name, type: 'WEBHOOK', status: 'ACTIVE', activeVersion: 1, config, exchangeAccountId, webhookId: endpoint.id },
      include: { exchangeAccount: { select: { id: true, label: true, exchange: true, marketType: true } } },
    });
  } catch (error) {
    await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } }).catch(() => undefined);
    throw error;
  }
  await prisma.botVersion.create({ data: { botId: bot.id, version: 1, config, checksum } });
  return {
    bot,
    webhook: { id: endpoint.id, url: `POST /api/webhooks/tradingview/${endpoint.id}`, signingSecret },
    mcp: { url: `POST /api/mcp/bots/${bot.id}`, password: signingSecret },
  };
}

export async function updateBotConfig(input: { botId: string; config: unknown }): Promise<Bot> {
  const { botId } = input;
  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot) throw new CommandError(404, 'BOT_NOT_FOUND', 'Bot not found');
  const config = WebhookBotConfigSchema.parse(input.config);
  const nextVersion = bot.activeVersion + 1;
  const checksum = hashToken(JSON.stringify(config));
  await prisma.botVersion.create({ data: { botId: bot.id, version: nextVersion, config, checksum } });
  return prisma.bot.update({ where: { id: bot.id }, data: { config, activeVersion: nextVersion } });
}

export type BotStatus = 'PAUSED' | 'ACTIVE' | 'STOPPED';

export async function deleteBotsByIds(ids: string[]): Promise<{ deleted: number }> {
  if (ids.length === 0) return { deleted: 0 };
  const bots = await prisma.bot.findMany({ where: { id: { in: ids } }, select: { id: true, webhookId: true } });
  const botIds = bots.map((bot) => bot.id);
  const endpointIds = bots.map((bot) => bot.webhookId).filter((id): id is string => Boolean(id));
  if (botIds.length === 0) return { deleted: 0 };
  await prisma.$transaction([
    prisma.botRun.deleteMany({ where: { botId: { in: botIds } } }),
    prisma.botVersion.deleteMany({ where: { botId: { in: botIds } } }),
    ...(endpointIds.length > 0 ? [prisma.webhookDelivery.deleteMany({ where: { endpointId: { in: endpointIds } } })] : []),
    ...(endpointIds.length > 0 ? [prisma.webhookEndpoint.deleteMany({ where: { id: { in: endpointIds } } })] : []),
    prisma.bot.deleteMany({ where: { id: { in: botIds } } }),
  ]);
  return { deleted: botIds.length };
}

export async function deleteAllBots(accountId?: string): Promise<{ deleted: number }> {
  const bots = await prisma.bot.findMany({
    ...(accountId ? { where: { exchangeAccountId: accountId } } : {}),
    select: { id: true },
  });
  return deleteBotsByIds(bots.map((bot) => bot.id));
}

export async function setBotStatus(input: { botId: string; status: BotStatus }): Promise<{ id: string; status: BotStatus }> {
  const { botId, status } = input;
  const bot = await prisma.bot.findUnique({ where: { id: botId }, include: { webhook: { select: { id: true } } } });
  if (!bot) throw new CommandError(404, 'BOT_NOT_FOUND', 'Bot not found');
  if (bot.status === status) return { id: botId, status };
  await prisma.bot.update({ where: { id: botId }, data: { status } });
  if (bot.webhook) await prisma.webhookEndpoint.update({ where: { id: bot.webhook.id }, data: { active: status === 'ACTIVE' } });
  return { id: botId, status };
}

export async function listBots() {
  return prisma.bot.findMany({
    include: { webhook: { select: { id: true, active: true } }, exchangeAccount: { select: { id: true, label: true, exchange: true, marketType: true } } },
    orderBy: { createdAt: 'desc' }
  });
}

export async function getBot(botId: string) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: { webhook: { select: { id: true, active: true } }, exchangeAccount: { select: { id: true, label: true, exchange: true, marketType: true } }, versions: { orderBy: { version: 'desc' } }, runs: { orderBy: { startedAt: 'desc' }, take: 20 } }
  });
  if (!bot) throw new CommandError(404, 'BOT_NOT_FOUND', 'Bot not found');
  return bot;
}

export type BotRunResult = {
  runId: string;
  status: 'STOPPED' | 'ERROR';
  orders: string[];
  orderResults: Array<{ orderId: string; state: string; exchangeOrderId?: string; filled?: number; error?: string }>;
  skipped: string[];
  notes: string[];
  price: string | null;
  positionSide: PositionSide | null;
  error?: string;
  managed?: ManageResult | undefined;
};

export async function runBotEvaluation(bot: Bot, config: WebhookBotConfig, signal: TradingViewSignal, policy: RiskPolicy, context: { deliveryId?: string } = {}): Promise<BotRunResult> {
  const runMetrics: Record<string, unknown> = { ...(context.deliveryId ? { deliveryId: context.deliveryId } : {}), nonce: signal.nonce, action: signal.action, symbol: signal.symbol };
  const run = await prisma.botRun.create({ data: { botId: bot.id, status: 'ACTIVE', metrics: runMetrics as unknown as Prisma.InputJsonValue } });
  const accountConfig = await getAccountConfig(bot.exchangeAccountId ?? undefined);
  try {
    const breaker = await checkCircuitBreaker();
    if (!breaker.ok) {
      await queueNotification({ channel: 'breaker', severity: 'CRITICAL', title: 'Circuit breaker blocked bot run', message: breaker.reason, payload: { botId: bot.id, signal: signal.nonce, ...breaker } });
      runMetrics.notes = [`Circuit breaker: ${breaker.reason}`];
      await prisma.botRun.update({ where: { id: run.id }, data: { status: 'STOPPED', stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
      return { runId: run.id, status: 'STOPPED', orders: [], orderResults: [], skipped: [], notes: [breaker.reason], price: null, positionSide: null };
    }
    const overrides: ManagementOverrides = {
      ...(signal.dca ? { dca: signal.dca } : {}),
      ...(signal.breakeven ? { breakeven: signal.breakeven } : {}),
      ...(signal.partialTps ? { partialTps: signal.partialTps } : {})
    };
    if (signal.action === 'MANAGE') {
      const managed = await manageBotPositions(bot.id, overrides);
      runMetrics.managed = managed as unknown as Prisma.InputJsonValue;
      await prisma.botRun.update({ where: { id: run.id }, data: { status: 'STOPPED', stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
      return { runId: run.id, status: 'STOPPED', orders: [], orderResults: [], skipped: [], notes: [], price: null, positionSide: null, managed };
    }
    let price: string | undefined;
    let equity = (await getSettings()).equity ?? '0';
    let maxEquity = (await getSettings()).peakEquity ?? equity;
    let currentPositionSide: PositionSide | undefined;
    let positionQuantity: number | undefined;
    let precision: Awaited<ReturnType<typeof marketPrecisionOf>> = null;
    const session = await connectToAccount(bot.exchangeAccountId ?? undefined);
    try {
      price = await session.adapter.getPrice(signal.symbol).catch(() => undefined);
      const quote = (signal.symbol.split('/')[1] ?? 'USDT').split(':')[0] ?? 'USDT';
      const balance = (await session.adapter.getBalance().catch(() => [])).find((entry) => entry.asset.toUpperCase() === quote.toUpperCase());
      if (balance && Number(balance.total) > 0) equity = balance.total;
      const position = (await session.adapter.getPositions().catch(() => [])).find((entry) => entry.symbol.toUpperCase() === signal.symbol.toUpperCase());
      if (position && position.side !== 'BOTH') { currentPositionSide = position.side; positionQuantity = Number(position.quantity); }
      precision = await marketPrecisionOf(session.adapter, signal.symbol).catch(() => null);
    } finally { await session.adapter.disconnect().catch(() => undefined); }
    const result = buildWebhookOrders({ signal, config, account: { id: accountConfig.id, exchange: accountConfig.exchange, marketType: accountConfig.marketType }, botId: bot.id, ...(price === undefined ? {} : { price }), ...(positionQuantity === undefined ? {} : { positionQuantity }), equity, maxEquity, ...(currentPositionSide === undefined ? {} : { currentPositionSide }), ...(precision ? { precision } : {}) });
    const created: string[] = [];
    const orderResults: BotRunResult['orderResults'] = [];
    for (const order of result.orders) {
      if (!order.reduceOnly) {
        const risk = evaluateOrder({ ...order, exchange: accountConfig.exchange, marketType: accountConfig.marketType, type: 'MARKET', quantity: order.quantity } as ResolvedOrderRequest, policy, { equity, dailyPnl: '0', weeklyPnl: '0', monthlyPnl: '0', peakEquity: maxEquity, exposure: '0', openPositions: 0, consecutiveLosses: 0, markPrice: price ?? '1', ...(price ? {} : { enforceMinimumNotional: false }) });
        if (!risk.approved) { result.skipped.push(`Risk rejected entry: ${risk.code} ${risk.reasons.join(', ')}`); continue; }
      }
      const row = await persistOrder({ ...order, idempotencyKey: `${order.idempotencyKey}:${bot.id}`, clientOrderId: order.clientOrderId }, { source: { kind: 'webhook', botId: bot.id, ...(context.deliveryId ? { deliveryId: context.deliveryId } : {}) }, ...(bot.exchangeAccountId ? { exchangeAccountId: bot.exchangeAccountId } : {}) });
      if (row.created) {
        created.push(row.order.id);
        const execution = await executeOrderNow(row.order.id);
        orderResults.push(execution);
      }
    }
    runMetrics.orders = created;
    runMetrics.orderResults = orderResults;
    runMetrics.skipped = result.skipped;
    runMetrics.notes = result.notes;
    runMetrics.price = price ?? null;
    runMetrics.positionSide = currentPositionSide ?? null;
    let managed: ManageResult | undefined;
    const effectiveConfig = mergeManagementOverrides(config, overrides);
    if (effectiveConfig.dca?.enabled || effectiveConfig.breakeven?.enabled || effectiveConfig.partialTps?.enabled) {
      try {
        managed = await manageBotPositions(bot.id, overrides);
        runMetrics.managed = managed as unknown as Prisma.InputJsonValue;
      } catch (error) {
        runMetrics.managedError = error instanceof Error ? error.message.slice(0, 300) : String(error);
      }
    }
    await prisma.botRun.update({ where: { id: run.id }, data: { status: 'STOPPED', stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
    return { runId: run.id, status: 'STOPPED', orders: created, orderResults, skipped: result.skipped, notes: result.notes, price: price ?? null, positionSide: currentPositionSide ?? null, managed };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
    runMetrics.error = message;
    await prisma.botRun.update({ where: { id: run.id }, data: { status: 'ERROR', stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
    return { runId: run.id, status: 'ERROR', orders: [], orderResults: [], skipped: [], notes: [], price: null, positionSide: null, error: message };
  }
}

function replayClaim(endpointId: string): ReplayStore {
  return {
    claim: async (key, ttlSeconds) => {
      const nonce = key.split(':').pop() ?? key;
      const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId }, select: { lastNonce: true, lastNonceAt: true } });
      if (endpoint?.lastNonce === nonce && endpoint.lastNonceAt !== null && Date.now() - endpoint.lastNonceAt.getTime() < ttlSeconds * 1000) return false;
      await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { lastNonce: nonce, lastNonceAt: new Date() } });
      return true;
    }
  };
}

export async function processWebhookSignal(input: { endpointId: string; rawBody: string; signature: string }): Promise<{ deliveryId: string; routed: number; failed: number; bots: Array<Record<string, unknown>>; note?: string }> {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: input.endpointId } });
  if (!endpoint) throw new CommandError(404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint not found');
  if (!endpoint.active) throw new CommandError(410, 'ENDPOINT_INACTIVE', 'Webhook endpoint is inactive');
  const verifier = new TradingViewWebhookVerifier(endpoint.signingSecret, replayClaim(endpoint.id));
  const signal = await verifier.verify(input.rawBody, input.signature);
  const delivery = await prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, nonce: signal.nonce, payloadHash: hashToken(input.rawBody), status: 'PROCESSING' } });
  try {
    const settings = await getSettings();
    if (!settings.tradingEnabled) {
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', error: 'Live trading is disabled', processedAt: new Date() } });
      return { deliveryId: delivery.id, routed: 0, failed: 1, bots: [], note: 'LIVE_TRADING_DISABLED' };
    }
    const policy = await loadPolicy();
    const parsed = TradingViewSignalSchema.parse(signal);
    const bots = await prisma.bot.findMany({ where: { status: 'ACTIVE', type: 'WEBHOOK', webhookId: endpoint.id } });
    if (bots.length === 0) {
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'DELIVERED', processedAt: new Date() } });
      return { deliveryId: delivery.id, routed: 0, failed: 0, bots: [], note: 'no ACTIVE bot for this endpoint' };
    }
    const botResults: Array<Record<string, unknown>> = [];
    let routed = 0;
    let failed = 0;
    for (const bot of bots) {
      let config: WebhookBotConfig;
      try { config = WebhookBotConfigSchema.parse(bot.config); } catch { botResults.push({ botId: bot.id, skipped: ['Bot config failed validation'] }); continue; }
      const result = await runBotEvaluation(bot, config, parsed, policy, { deliveryId: delivery.id });
      if (result.status === 'ERROR') failed += 1; else routed += 1;
      botResults.push({ botId: bot.id, runId: result.runId, status: result.status, orders: result.orders, skipped: result.skipped, notes: result.notes, price: result.price, positionSide: result.positionSide, ...(result.error ? { error: result.error } : {}), ...(result.managed ? { managed: result.managed } : {}) });
      await queueNotification({
        channel: 'bot',
        severity: result.status === 'ERROR' ? 'WARN' : 'INFO',
        title: `Bot ${bot.name} ${result.status === 'ERROR' ? 'errored' : result.orders.length > 0 ? `placed ${result.orders.length} order(s)` : result.skipped.length > 0 ? 'skipped orders' : 'ran'}`,
        message: `${parsed.symbol} ${parsed.action}${result.status === 'ERROR' && result.error ? ` · ${result.error}` : ''}${result.price ? ` @ ${result.price}` : ''}`,
        payload: { botId: bot.id, runId: result.runId, action: parsed.action, symbol: parsed.symbol, orders: result.orders, skipped: result.skipped, notes: result.notes }
      });
    }
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: failed === 0 ? 'DELIVERED' : 'FAILED', error: failed > 0 ? `${failed} bot run(s) failed` : null, processedAt: new Date(), botsRouted: routed, botsFailed: failed } });
    await queueNotification({
      channel: 'webhook',
      severity: failed > 0 ? 'WARN' : 'INFO',
      title: `Webhook delivery ${failed === 0 ? 'completed' : 'partially failed'}`,
      message: `${routed} bot(s) processed, ${failed} failed`,
      payload: { deliveryId: delivery.id, endpointId: endpoint.id, routed, failed }
    });
    return { deliveryId: delivery.id, routed, failed, bots: botResults };
  } catch (error) {
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 500) : String(error), processedAt: new Date() } });
    throw error;
  }
}