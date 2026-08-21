import { randomUUID } from 'node:crypto';
import { WebhookBotConfigSchema, TradingViewSignalSchema, normalizeSymbolForMarket, type PositionSide, type ResolvedOrderRequest, type TradingViewSignal, type WebhookBotAction, type WebhookBotConfig } from '@platform/contracts';
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
import { manageBotPositions, mergeManagementOverrides, resolveManagementConfig, type ManageResult } from './manage.js';
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
    webhook: { id: endpoint.id, url: `/api/webhooks/tradingview/${endpoint.id}`, signingSecret },
    mcp: { url: `/api/mcp/bots/${bot.id}`, password: signingSecret },
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
  const finish = async (status: 'STOPPED' | 'ERROR', patch: Partial<BotRunResult> & { notes?: string[]; skipped?: string[] }, error?: string): Promise<BotRunResult> => {
    if (error) runMetrics.error = error;
    if (patch.notes?.length) runMetrics.notes = patch.notes;
    if (patch.skipped?.length) runMetrics.skipped = patch.skipped;
    await prisma.botRun.update({ where: { id: run.id }, data: { status, stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
    return { runId: run.id, status, orders: [], orderResults: [], skipped: patch.skipped ?? [], notes: patch.notes ?? [], price: null, positionSide: null, ...(error ? { error } : {}) };
  };
  let session: Awaited<ReturnType<typeof connectToAccount>> | undefined;
  try {
    const botMarketType = config.marketType ?? 'USDT_FUTURES';
    const normalizedSymbol = normalizeSymbolForMarket(signal.symbol, botMarketType);
    if (!normalizedSymbol) {
      return await finish('STOPPED', { skipped: [`Symbol ${signal.symbol} cannot trade on a ${botMarketType === 'SPOT' ? 'spot' : 'USDT futures'} bot`] });
    }
    const signalBare = (signal.symbol.split(':')[0] ?? signal.symbol).toUpperCase();
    const skippedEarly: string[] = [];
    if (!config.symbols.some((entry) => entry === '*' || (entry.split(':')[0] ?? entry).toUpperCase() === signalBare)) skippedEarly.push(`Symbol ${signal.symbol} not in configured bot symbols`);
    else if (config.actions && !config.actions.includes(signal.action as WebhookBotAction)) skippedEarly.push(`Action ${signal.action} not in configured bot actions`);
    if (skippedEarly.length > 0) return await finish('STOPPED', { skipped: skippedEarly });
    const [breaker, accountConfig] = await Promise.all([checkCircuitBreaker(), getAccountConfig(bot.exchangeAccountId ?? undefined)]);
    if (!breaker.ok) {
      await queueNotification({ channel: 'breaker', severity: 'CRITICAL', title: 'Circuit breaker blocked bot run', message: breaker.reason, payload: { botId: bot.id, signal: signal.nonce, ...breaker } });
      return await finish('STOPPED', { notes: [`Circuit breaker: ${breaker.reason}`] });
    }
    if (signal.exchange.toLowerCase() !== accountConfig.exchange.toLowerCase()) {
      return await finish('STOPPED', { skipped: [`Exchange ${signal.exchange} does not match bot account ${accountConfig.exchange}`] });
    }
    const overrides: ManagementOverrides = {
      ...(signal.dca ? { dca: signal.dca } : {}),
      ...(signal.breakeven ? { breakeven: signal.breakeven } : {}),
      ...(signal.partialTps ? { partialTps: signal.partialTps } : {})
    };
    const effectiveSignal = { ...signal, symbol: normalizedSymbol };
    session = await connectToAccount(bot.exchangeAccountId ?? undefined, botMarketType, accountConfig);
    if (effectiveSignal.action === 'MANAGE') {
      const managed = await manageBotPositions(bot.id, overrides, { config: accountConfig, adapter: session.adapter, botConfig: config, marketType: botMarketType });
      runMetrics.managed = managed as unknown as Prisma.InputJsonValue;
      runMetrics.orders = [];
      await prisma.botRun.update({ where: { id: run.id }, data: { status: 'STOPPED', stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
      return { runId: run.id, status: 'STOPPED', orders: [], orderResults: [], skipped: [], notes: [], price: null, positionSide: null, managed };
    }
    const isEntry = ['BUY', 'LONG', 'SELL', 'SHORT'].includes(effectiveSignal.action);
    const needsPositionState = ['CLOSE_LONG', 'CLOSE_SHORT', 'PARTIAL_EXIT', 'REVERSE'].includes(effectiveSignal.action);
    const needsPrice = isEntry || effectiveSignal.action === 'REVERSE';
    const base = (normalizedSymbol.split('/')[0] ?? '').split(':')[0] ?? '';
    const [price, balances, position, precision, settings] = await Promise.all([
      needsPrice ? session.adapter.getPrice(normalizedSymbol).catch(() => undefined) : Promise.resolve(undefined as string | undefined),
      botMarketType === 'SPOT' && needsPositionState ? session.adapter.getBalance().catch(() => []) : Promise.resolve([]),
      needsPositionState ? session.adapter.getPositions().catch(() => []).then((positions) => positions.find((entry) => entry.symbol.toUpperCase() === normalizedSymbol.split(':')[0]?.toUpperCase())) : Promise.resolve(undefined),
      needsPrice ? marketPrecisionOf(session.adapter, normalizedSymbol).catch(() => null) : Promise.resolve(null),
      needsPrice ? getSettings() : Promise.resolve(null),
    ]);
    const equity = settings?.equity ?? '0';
    const maxEquity = settings?.peakEquity ?? equity;
    let currentPositionSide: PositionSide | undefined;
    let positionQuantity: number | undefined;
    if (position && position.side !== 'BOTH') {
      currentPositionSide = position.side;
      positionQuantity = Number(position.quantity);
    } else if (botMarketType === 'SPOT' && base) {
      const holding = balances.find((entry) => entry.asset.toUpperCase() === base.toUpperCase());
      const free = Number(holding?.free ?? 0);
      if (Number.isFinite(free) && free > 0) { currentPositionSide = 'LONG'; positionQuantity = free; }
    }
    const result = buildWebhookOrders({ signal: effectiveSignal, config, account: { id: accountConfig.id, exchange: accountConfig.exchange, marketType: botMarketType }, botId: bot.id, ...(price === undefined ? {} : { price }), ...(positionQuantity === undefined ? {} : { positionQuantity }), equity, maxEquity, ...(currentPositionSide === undefined ? {} : { currentPositionSide }), ...(precision ? { precision } : {}) });
    const created: string[] = [];
    const orderResults: BotRunResult['orderResults'] = [];
    for (const order of result.orders) {
      if (!order.reduceOnly) {
        const risk = evaluateOrder({ ...order, exchange: accountConfig.exchange, marketType: order.marketType, type: 'MARKET', quantity: order.quantity } as ResolvedOrderRequest, policy, { equity, dailyPnl: '0', weeklyPnl: '0', monthlyPnl: '0', peakEquity: maxEquity, exposure: '0', openPositions: 0, consecutiveLosses: 0, markPrice: price ?? '1', ...(price ? {} : { enforceMinimumNotional: false }) });
        if (!risk.approved) { result.skipped.push(`Risk rejected entry: ${risk.code} ${risk.reasons.join(', ')}`); continue; }
      }
      const row = await persistOrder({ ...order, idempotencyKey: `${order.idempotencyKey}:${bot.id}`, clientOrderId: order.clientOrderId }, { source: { kind: 'webhook', botId: bot.id, ...(context.deliveryId ? { deliveryId: context.deliveryId } : {}) }, ...(bot.exchangeAccountId ? { exchangeAccountId: bot.exchangeAccountId } : {}), marketType: order.marketType }, accountConfig);
      if (row.created) {
        created.push(row.order.id);
        const execution = await executeOrderNow(row.order.id, { config: accountConfig, adapter: session.adapter });
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
    const effectiveConfig = mergeManagementOverrides(resolveManagementConfig(config), overrides);
    if (effectiveConfig.dca?.enabled || effectiveConfig.breakeven?.enabled || effectiveConfig.partialTps?.enabled) {
      try {
        managed = await manageBotPositions(bot.id, overrides, { config: accountConfig, adapter: session.adapter, botConfig: config, marketType: botMarketType });
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
  } finally {
    await session?.adapter.disconnect().catch(() => undefined);
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

export async function verifyWebhookSignal(input: { endpointId: string; rawBody: string; signature: string }): Promise<{ deliveryId: string; endpoint: { id: string; signingSecret: string }; signal: TradingViewSignal }> {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: input.endpointId } });
  if (!endpoint) throw new CommandError(404, 'ENDPOINT_NOT_FOUND', 'Webhook endpoint not found');
  if (!endpoint.active) throw new CommandError(410, 'ENDPOINT_INACTIVE', 'Webhook endpoint is inactive');
  const verifier = new TradingViewWebhookVerifier(endpoint.signingSecret, replayClaim(endpoint.id));
  const signal = await verifier.verify(input.rawBody, input.signature);
  const parsed = TradingViewSignalSchema.parse(signal);
  const delivery = await prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, nonce: signal.nonce, payloadHash: hashToken(input.rawBody), status: 'PROCESSING' } });
  return { deliveryId: delivery.id, endpoint: { id: endpoint.id, signingSecret: endpoint.signingSecret }, signal: parsed };
}

export async function executeWebhookSignal(input: { deliveryId: string; endpointId: string; signal: TradingViewSignal }): Promise<{ deliveryId: string; routed: number; failed: number; bots: Array<Record<string, unknown>>; note?: string }> {
  const { deliveryId, endpointId, signal } = input;
  try {
    const settings = await getSettings();
    if (!settings.tradingEnabled) {
      await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', error: 'Live trading is disabled', processedAt: new Date() } });
      return { deliveryId, routed: 0, failed: 1, bots: [], note: 'LIVE_TRADING_DISABLED' };
    }
    const policy = await loadPolicy();
    const bots = await prisma.bot.findMany({ where: { status: 'ACTIVE', type: 'WEBHOOK', webhookId: endpointId } });
    if (bots.length === 0) {
      await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'DELIVERED', processedAt: new Date() } });
      return { deliveryId, routed: 0, failed: 0, bots: [], note: 'no ACTIVE bot for this endpoint' };
    }
    const botResults: Array<Record<string, unknown>> = [];
    let routed = 0;
    let failed = 0;
    for (const bot of bots) {
      let config: WebhookBotConfig;
      try { config = WebhookBotConfigSchema.parse(bot.config); } catch { botResults.push({ botId: bot.id, skipped: ['Bot config failed validation'] }); continue; }
      const result = await runBotEvaluation(bot, config, signal, policy, { deliveryId });
      if (result.status === 'ERROR') failed += 1; else routed += 1;
      botResults.push({ botId: bot.id, runId: result.runId, status: result.status, orders: result.orders, skipped: result.skipped, notes: result.notes, price: result.price, positionSide: result.positionSide, ...(result.error ? { error: result.error } : {}), ...(result.managed ? { managed: result.managed } : {}) });
      await queueNotification({
        channel: 'bot',
        severity: result.status === 'ERROR' ? 'WARN' : 'INFO',
        title: `Bot ${bot.name} ${result.status === 'ERROR' ? 'errored' : result.orders.length > 0 ? `placed ${result.orders.length} order(s)` : result.skipped.length > 0 ? 'skipped orders' : 'ran'}`,
        message: `${signal.symbol} ${signal.action}${result.status === 'ERROR' && result.error ? ` · ${result.error}` : ''}${result.price ? ` @ ${result.price}` : ''}`,
        payload: { botId: bot.id, runId: result.runId, action: signal.action, symbol: signal.symbol, orders: result.orders, skipped: result.skipped, notes: result.notes }
      });
    }
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: failed === 0 ? 'DELIVERED' : 'FAILED', error: failed > 0 ? `${failed} bot run(s) failed` : null, processedAt: new Date(), botsRouted: routed, botsFailed: failed } });
    await queueNotification({
      channel: 'webhook',
      severity: failed > 0 ? 'WARN' : 'INFO',
      title: `Webhook delivery ${failed === 0 ? 'completed' : 'partially failed'}`,
      message: `${routed} bot(s) processed, ${failed} failed`,
      payload: { deliveryId, endpointId, routed, failed }
    });
    return { deliveryId, routed, failed, bots: botResults };
  } catch (error) {
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 500) : String(error), processedAt: new Date() } });
    throw error;
  }
}

export async function processWebhookSignal(input: { endpointId: string; rawBody: string; signature: string }): Promise<{ deliveryId: string; routed: number; failed: number; bots: Array<Record<string, unknown>>; note?: string }> {
  const { deliveryId, endpoint, signal } = await verifyWebhookSignal(input);
  return executeWebhookSignal({ deliveryId, endpointId: endpoint.id, signal });
}