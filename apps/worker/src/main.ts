import './env.js';
import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, encryption, prisma, type ExchangeAccount, type ExchangeCredential, type OrderIntent } from '@platform/database';
import { createExchangeAdapter } from '@platform/exchange-adapters';
import { ExchangeError, type ExchangeAdapter, type ExchangeOrder } from '@platform/exchange-core';
import { evaluateOrder, type RiskPolicy } from '@platform/risk-engine';
import { OrderRequestSchema, TradingViewSignalSchema, WebhookBotConfigSchema, type Allocation, type ExchangeId, type MarketType, type PositionSide, type ResolvedOrderRequest, type TradingViewSignal, type WebhookBotConfig } from '@platform/contracts';
import { sizeOrder } from '@platform/trading-core';
import { buildWebhookOrders } from '@platform/bot-engine';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const ordersQueue = new Queue('orders', { connection });
const reconciliationQueue = new Queue('reconciliation', { connection });

const TERMINAL_STATES = ['FILLED', 'CANCELED', 'REJECTED', 'FAILED'] as const;
const STALE_STATES = ['SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'CANCEL_PENDING'] as const;

const defaultPolicy: RiskPolicy = { maxDailyLoss: '1000', maxWeeklyLoss: '3000', maxMonthlyLoss: '10000', maxDrawdownPercent: '20', maxConcurrentPositions: 10, maxExposure: '100000', maxLeverage: 20, maxRiskPerTrade: '500', maxPositionSize: '25000', consecutiveLossCooldown: 3, tradingEnabled: true };

async function loadPolicy(workspaceId: string): Promise<RiskPolicy> {
  const row = await prisma.riskPolicy.findUnique({ where: { workspaceId } });
  if (!row) return defaultPolicy;
  return { maxDailyLoss: row.maxDailyLoss.toString(), maxWeeklyLoss: row.maxWeeklyLoss.toString(), maxMonthlyLoss: row.maxMonthlyLoss.toString(), maxDrawdownPercent: row.maxDrawdownPercent.toString(), maxConcurrentPositions: row.maxConcurrentPositions, maxExposure: row.maxExposure.toString(), maxLeverage: row.maxLeverage, maxRiskPerTrade: row.maxRiskPerTrade.toString(), maxPositionSize: row.maxPositionSize.toString(), consecutiveLossCooldown: row.consecutiveLossCooldown, tradingEnabled: row.tradingEnabled };
}

function decryptCredentials(credential: ExchangeCredential): { apiKey: string; secret: string; passphrase?: string } {
  return JSON.parse(encryption.decrypt(credential.encryptedPayload as { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string; keyId: string }, `exchange-credential:${credential.exchangeAccountId}`)) as { apiKey: string; secret: string; passphrase?: string };
}

async function connectToAccount(account: ExchangeAccount): Promise<{ adapter: ExchangeAdapter; credential: ExchangeCredential }> {
  const credential = await prisma.exchangeCredential.findFirstOrThrow({ where: { exchangeAccountId: account.id, revokedAt: null }, orderBy: { version: 'desc' } });
  const adapter = createExchangeAdapter(account.exchange.toLowerCase() as ExchangeId, account.marketType);
  try {
    await adapter.connect(decryptCredentials(credential));
    await prisma.exchangeAccount.update({ where: { id: account.id }, data: { lastConnectedAt: new Date(), credentialStatus: 'VERIFIED' } }).catch(() => undefined);
    return { adapter, credential };
  } catch (error) {
    await adapter.disconnect().catch(() => undefined);
    throw error;
  }
}

async function setState(id: string, state: OrderIntent['state'], rejectionReason?: string): Promise<void> {
  await prisma.orderIntent.update({ where: { id }, data: { state, ...(rejectionReason === undefined ? {} : { rejectionReason }) } });
}

async function filledQuantityOf(orderId: string): Promise<number> {
  const rows = await prisma.execution.findMany({ where: { orderIntentId: orderId }, select: { quantity: true } });
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function recordExecution(order: OrderIntent, exchangeOrder: ExchangeOrder, fillFraction: number, recordedFilled: number): Promise<void> {
  const quantity = new Prisma.Decimal(Number(exchangeOrder.filledQuantity) * fillFraction);
  const price = new Prisma.Decimal(exchangeOrder.averagePrice ?? exchangeOrder.quantity);
  await prisma.execution.create({ data: { orderIntentId: order.id, exchangeExecutionId: recordedFilled === 0 ? exchangeOrder.id : `${exchangeOrder.id}:${recordedFilled}`, quantity, price, fee: new Prisma.Decimal(0), feeAsset: null, executedAt: new Date() } });
}

async function handleOrderError(order: OrderIntent, error: unknown, job: Job, maxRetries: number): Promise<OrderIntent['state']> {
  const exchangeError = error instanceof ExchangeError ? error : new ExchangeError('INTERNAL', error instanceof Error ? error.message : String(error), false);
  const canRetry = exchangeError.retryable && job.attemptsMade < maxRetries;
  if (canRetry) throw exchangeError;
  const finalState = exchangeError.retryable ? 'FAILED' : 'REJECTED';
  await setState(order.id, finalState, exchangeError.code);
  return finalState;
}

function reconcileStatus(exchangeOrder: ExchangeOrder): { state: OrderIntent['state']; rejectionReason?: string } {
  switch (exchangeOrder.status) {
    case 'FILLED': return { state: 'FILLED' };
    case 'PARTIALLY_FILLED': return { state: 'PARTIALLY_FILLED' };
    case 'CANCELED': return { state: 'CANCELED' };
    case 'EXPIRED': return { state: 'CANCELED', rejectionReason: 'EXPIRED' };
    case 'REJECTED': return { state: 'REJECTED', rejectionReason: 'REJECTED' };
    default: return { state: 'ACKNOWLEDGED' };
  }
}

async function reconcileOrder(adapter: ExchangeAdapter, order: OrderIntent): Promise<{ status: ExchangeOrder['status']; changed: boolean; recordedDelta: number }> {
  if (!order.exchangeOrderId) throw new ExchangeError('NOT_ON_EXCHANGE', 'Order has no exchange order id', false);
  const exchangeOrder = await adapter.getOrder(order.exchangeOrderId, order.symbol);
  const recordedFilled = await filledQuantityOf(order.id);
  const filled = Number(exchangeOrder.filledQuantity ?? 0);
  const delta = filled - recordedFilled;
  if (delta > 1e-9) {
    const fillFraction = filled > 0 ? delta / filled : 0;
    await recordExecution(order, exchangeOrder, fillFraction, recordedFilled);
  }
  const target = reconcileStatus(exchangeOrder);
  const changed = delta > 1e-9 || order.state !== target.state;
  if (changed && target.state !== order.state) await setState(order.id, target.state, target.rejectionReason);
  return { status: exchangeOrder.status, changed, recordedDelta: delta > 1e-9 ? delta : 0 };
}

async function executeOrder(job: Job<{ action: 'execute'; orderId: string }>): Promise<Record<string, unknown>> {
  const order = await prisma.orderIntent.findUniqueOrThrow({ where: { id: job.data.orderId }, include: { exchangeAccount: true } });
  if ((TERMINAL_STATES as readonly string[]).includes(order.state)) return { orderId: order.id, status: `ALREADY_${order.state}`, skipped: true };
  const account = order.exchangeAccount;
  let adapter: ExchangeAdapter | undefined;
  try {
    const session = await connectToAccount(account);
    adapter = session.adapter;
    if (order.exchangeOrderId) {
      const result = await reconcileOrder(adapter, order);
      return { orderId: order.id, exchangeOrderId: order.exchangeOrderId, status: result.status, reconciled: true, changed: result.changed };
    }
    await setState(order.id, 'SUBMITTING');
    let quantity = order.quantity.toString();
    if (order.allocation) {
      const price = order.price?.toString() ?? await adapter.getPrice(order.symbol);
      const balances = await adapter.getBalance();
      const quote = order.symbol.split('/')[1] ?? 'USDT';
      const equity = balances.find((balance) => balance.asset === quote)?.free ?? '0';
      const maxEquity = account.peakEquity?.toString() ?? equity;
      const sized = sizeOrder({ allocation: order.allocation as unknown as Allocation, marketType: account.marketType, price, equity, maxEquity, ...(order.leverage == null ? {} : { leverage: order.leverage }), ...(order.stopPrice ? { stopPrice: order.stopPrice.toString() } : {}) });
      if (!sized.ok || sized.quantity === undefined) {
        await setState(order.id, 'REJECTED', `SIZING:${sized.reasons.join(';')}`);
        return { orderId: order.id, status: 'REJECTED', reasons: sized.reasons };
      }
      quantity = sized.quantity;
      if (quantity !== order.quantity.toString() || (order.leverage !== null && order.leverage !== sized.leverage)) {
        await prisma.orderIntent.update({ where: { id: order.id }, data: { quantity: new Prisma.Decimal(quantity), ...(order.leverage === null || order.leverage !== sized.leverage ? { leverage: sized.leverage } : {}) } });
      }
    }
    if (account.marketType !== 'SPOT') {
      await adapter.setMarginMode(order.symbol, order.marginMode ?? 'ISOLATED').catch(() => undefined);
    }
    if (account.marketType !== 'SPOT' && order.leverage) {
      await adapter.setLeverage(order.symbol, order.leverage).catch(() => undefined);
    }
    const request = OrderRequestSchema.parse({ exchangeAccountId: account.id, exchange: account.exchange.toLowerCase() as ExchangeId, marketType: account.marketType, symbol: order.symbol, side: order.side, positionSide: order.positionSide, type: order.orderType, quantity, price: order.price?.toString(), stopPrice: order.stopPrice?.toString(), reduceOnly: order.reduceOnly, postOnly: order.postOnly, clientOrderId: order.clientOrderId, idempotencyKey: order.idempotencyKey }) as ResolvedOrderRequest;
    const exchangeOrder = await adapter.placeOrder(request);
    await prisma.orderIntent.update({ where: { id: order.id }, data: { exchangeOrderId: exchangeOrder.id } });
    const recordedFilled = Number(exchangeOrder.filledQuantity ?? 0);
    if (exchangeOrder.status === 'FILLED' || exchangeOrder.status === 'PARTIALLY_FILLED' || (exchangeOrder.status === 'NEW' && recordedFilled > 0)) {
      await recordExecution(order, exchangeOrder, 1, 0);
    }
    await setState(order.id, exchangeOrder.status === 'FILLED' ? 'FILLED' : exchangeOrder.status === 'PARTIALLY_FILLED' || (exchangeOrder.status === 'NEW' && recordedFilled > 0) ? 'PARTIALLY_FILLED' : exchangeOrder.status === 'REJECTED' ? 'REJECTED' : exchangeOrder.status === 'CANCELED' ? 'CANCELED' : 'ACKNOWLEDGED', exchangeOrder.status === 'REJECTED' ? exchangeOrder.rawStatus : undefined);
    return { orderId: order.id, exchangeOrderId: exchangeOrder.id, status: exchangeOrder.status, rawStatus: exchangeOrder.rawStatus, filled: recordedFilled };
  } catch (error) {
    const finalState = await handleOrderError(order, error, job, 5);
    return { orderId: order.id, status: finalState, error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message.slice(0, 200) : String(error) };
  } finally {
    await adapter?.disconnect().catch(() => undefined);
  }
}

async function cancelOrder(job: Job<{ action: 'cancel'; orderId: string }>): Promise<Record<string, unknown>> {
  const order = await prisma.orderIntent.findUniqueOrThrow({ where: { id: job.data.orderId }, include: { exchangeAccount: true } });
  if ((TERMINAL_STATES as readonly string[]).includes(order.state)) return { orderId: order.id, status: `ALREADY_${order.state}`, skipped: true };
  let adapter: ExchangeAdapter | undefined;
  try {
    const session = await connectToAccount(order.exchangeAccount);
    adapter = session.adapter;
    if (!order.exchangeOrderId) throw new ExchangeError('NOT_ON_EXCHANGE', 'Order has no exchange order id', false);
    const result = await adapter.cancelOrder(order.exchangeOrderId, order.symbol);
    if (result.status === 'FILLED') {
      await reconcileOrder(adapter, order);
      return { orderId: order.id, exchangeOrderId: order.exchangeOrderId, status: result.status };
    }
    await setState(order.id, 'CANCELED');
    return { orderId: order.id, exchangeOrderId: order.exchangeOrderId, status: result.status };
  } catch (error) {
    const finalState = await handleOrderError(order, error, job, 5);
    return { orderId: order.id, status: finalState, error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message.slice(0, 200) : String(error) };
  } finally {
    await adapter?.disconnect().catch(() => undefined);
  }
}

async function closeAll(job: Job<{ action: 'close-all'; exchangeAccountId: string }>): Promise<Record<string, unknown>> {
  const account = await prisma.exchangeAccount.findUniqueOrThrow({ where: { id: job.data.exchangeAccountId } });
  let adapter: ExchangeAdapter | undefined;
  try {
    const session = await connectToAccount(account);
    adapter = session.adapter;
    const openOrders = await adapter.getOrders();
    const cancelFailures: string[] = [];
    let canceled = 0;
    for (const openOrder of openOrders) {
      try {
        await adapter.cancelOrder(openOrder.id, openOrder.symbol);
        canceled += 1;
      } catch (error) {
        cancelFailures.push(`${openOrder.id}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      }
    }
    const affected = await prisma.orderIntent.updateMany({ where: { exchangeAccountId: account.id, state: { in: ['ACKNOWLEDGED', 'QUEUED', 'SUBMITTING', 'PARTIALLY_FILLED', 'CANCEL_PENDING'] } }, data: { state: 'CANCELED' } });
    const positions = await adapter.getPositions();
    const closeFailures: string[] = [];
    let closed = 0;
    for (const position of positions) {
      const opposite: 'BUY' | 'SELL' = position.side === 'LONG' ? 'SELL' : 'BUY';
      try {
        const closeOrder = await adapter.placeOrder({ exchangeAccountId: account.id, exchange: account.exchange.toLowerCase() as ExchangeId, marketType: account.marketType as MarketType, symbol: position.symbol, side: opposite, positionSide: 'BOTH', type: 'MARKET', quantity: position.quantity, reduceOnly: true, postOnly: false, timeInForce: 'GTC', clientOrderId: `close-${Date.now()}-${closed}`, idempotencyKey: `close-${account.id}-${position.symbol}-${Date.now()}` });
        if (closeOrder.status === 'FILLED' || closeOrder.status === 'PARTIALLY_FILLED') closed += 1;
      } catch (error) {
        closeFailures.push(`${position.symbol}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      }
    }
    return { exchangeAccountId: account.id, canceled, cancelFailures, dbOrdersCanceled: affected.count, positionsToClose: positions.length, closed, closeFailures };
  } catch (error) {
    throw error;
  } finally {
    await adapter?.disconnect().catch(() => undefined);
  }
}

type PersistedOrderLike = { symbol: string; side: 'BUY' | 'SELL'; positionSide: 'LONG' | 'SHORT' | 'BOTH'; type: string; quantity: string; price?: string; stopPrice?: string; reduceOnly: boolean; postOnly: boolean; clientOrderId: string; idempotencyKey: string };

async function persistOrder(order: PersistedOrderLike, account: ExchangeAccount, state: OrderIntent['state']): Promise<{ order: OrderIntent; created: boolean }> {
  try {
    return { order: await prisma.orderIntent.create({ data: { workspaceId: account.workspaceId, exchangeAccountId: account.id, idempotencyKey: order.idempotencyKey, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, positionSide: order.positionSide, orderType: order.type, marketType: account.marketType, quantity: new Prisma.Decimal(order.quantity), ...(order.price ? { price: new Prisma.Decimal(order.price) } : {}), ...(order.stopPrice ? { stopPrice: new Prisma.Decimal(order.stopPrice) } : {}), reduceOnly: order.reduceOnly, postOnly: order.postOnly, state } }), created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.orderIntent.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: account.workspaceId, idempotencyKey: order.idempotencyKey } } });
      if (existing) return { order: existing, created: false };
    }
    throw error;
  }
}

type BotWithAccount = Prisma.BotGetPayload<{ include: { exchangeAccount: true } }>;

const notificationsQueue = new Queue('notifications', { connection });

async function runBotEvaluation(bot: BotWithAccount, config: WebhookBotConfig, signal: TradingViewSignal, policy: RiskPolicy, context: { deliveryId?: string } = {}): Promise<{ runId: string; accountId: string; status: 'STOPPED' | 'ERROR'; orders: string[]; skipped: string[]; notes: string[]; price: string | null; positionSide: PositionSide | null; error?: string }> {
  const account = bot.exchangeAccount;
  const runMetrics: Record<string, unknown> = { ...(context.deliveryId ? { deliveryId: context.deliveryId } : {}), nonce: signal.nonce, action: signal.action, symbol: signal.symbol };
  const run = await prisma.botRun.create({ data: { botId: bot.id, status: 'ACTIVE', metrics: runMetrics as unknown as Prisma.InputJsonValue } });
  try {
    let price: string | undefined;
    let equity = (account.equity ?? new Prisma.Decimal(0)).toString();
    let maxEquity = (account.peakEquity ?? new Prisma.Decimal(0)).toString();
    let currentPositionSide: PositionSide | undefined;
    const session = await connectToAccount(account);
    try {
      price = await session.adapter.getPrice(signal.symbol).catch(() => undefined);
      const quote = signal.symbol.split('/')[1] ?? 'USDT';
      const balance = (await session.adapter.getBalance().catch(() => [])).find((entry) => entry.asset.toUpperCase() === quote.toUpperCase());
      if (balance && Number(balance.free) > 0) equity = balance.free;
      const position = (await session.adapter.getPositions().catch(() => [])).find((entry) => entry.symbol.toUpperCase() === signal.symbol.toUpperCase());
      if (position && position.side !== 'BOTH') currentPositionSide = position.side;
    } finally { await session.adapter.disconnect().catch(() => undefined); }
    const result = buildWebhookOrders({ signal, config, account: { id: account.id, exchange: account.exchange.toLowerCase(), marketType: account.marketType }, ...(price === undefined ? {} : { price }), equity, maxEquity, ...(currentPositionSide === undefined ? {} : { currentPositionSide }) });
    const created: string[] = [];
    for (const order of result.orders) {
      if (!order.reduceOnly) {
        const risk = evaluateOrder({ ...order, exchange: account.exchange.toLowerCase() as ExchangeId, marketType: account.marketType, type: 'MARKET', quantity: order.quantity } as ResolvedOrderRequest, policy, { equity, dailyPnl: '0', weeklyPnl: '0', monthlyPnl: '0', peakEquity: maxEquity, exposure: '0', openPositions: 0, consecutiveLosses: 0, markPrice: price ?? '1', ...(price ? {} : { enforceMinimumNotional: false }) });
        if (!risk.approved) { result.skipped.push(`Risk rejected entry: ${risk.code} ${risk.reasons.join(', ')}`); continue; }
      }
      const row = await persistOrder({ ...order, idempotencyKey: `${order.idempotencyKey}:${bot.id}`, clientOrderId: order.clientOrderId }, account, 'QUEUED');
      if (row.created) {
        created.push(row.order.id);
        await ordersQueue.add('execute', { action: 'execute', orderId: row.order.id }, { jobId: row.order.id, attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
      }
    }
    runMetrics.orders = created;
    runMetrics.skipped = result.skipped;
    runMetrics.notes = result.notes;
    runMetrics.price = price ?? null;
    runMetrics.positionSide = currentPositionSide ?? null;
    await prisma.botRun.update({ where: { id: run.id }, data: { status: 'STOPPED', stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
    return { runId: run.id, accountId: account.id, status: 'STOPPED', orders: created, skipped: result.skipped, notes: result.notes, price: price ?? null, positionSide: currentPositionSide ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
    runMetrics.error = message;
    await prisma.botRun.update({ where: { id: run.id }, data: { status: 'ERROR', stoppedAt: new Date(), metrics: runMetrics as unknown as Prisma.InputJsonValue } });
    return { runId: run.id, accountId: account.id, status: 'ERROR', orders: [], skipped: [], notes: [], price: null, positionSide: null, error: message };
  }
}

async function createNotification(job: Job<{ workspaceId: string; channel: string; severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'; title: string; message?: string; payload?: unknown }>): Promise<Record<string, unknown>> {
  const { workspaceId, channel, severity, title, message, payload } = job.data;
  const duplicate = await prisma.notification.findFirst({ where: { workspaceId, channel, title, createdAt: { gte: new Date(Date.now() - 30_000) } }, orderBy: { createdAt: 'desc' } });
  if (duplicate) return { notificationId: duplicate.id, deduped: true };
  const created = await prisma.notification.create({ data: { workspaceId, channel, severity, title, ...(message ? { message } : {}), ...(payload ? { payload: payload as Prisma.InputJsonValue } : {}) } });
  return { notificationId: created.id, deduped: false };
}

function queueNotification(workspaceId: string, data: { channel: string; severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'; title: string; message?: string; payload?: unknown; jobId: string }): Promise<void> {
  const { jobId, ...rest } = data;
  return notificationsQueue.add('notify', { workspaceId, ...rest }, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: false }).then(() => undefined).catch(() => undefined);
}

async function processWebhook(job: Job<{ deliveryId: string; endpointId: string; signal: TradingViewSignal }>): Promise<Record<string, unknown>> {
  const { deliveryId, signal } = job.data;
  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { endpoint: true } });
  await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'PROCESSING', attempts: { increment: 1 } } });
  try {
    const endpoint = delivery.endpoint;
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: endpoint.workspaceId } });
    const policy = await loadPolicy(workspace.id);
    const parsed = TradingViewSignalSchema.parse(signal);
    const bots = await prisma.bot.findMany({ where: { workspaceId: workspace.id, type: 'WEBHOOK', status: 'ACTIVE' }, include: { exchangeAccount: true } });
    const botResults: Array<Record<string, unknown>> = [];
    let routed = 0;
    let failed = 0;
    for (const bot of bots) {
      const account = bot.exchangeAccount;
      if (!account.tradingEnabled) { botResults.push({ botId: bot.id, skipped: ['Trading not enabled on exchange account'] }); continue; }
      let config: WebhookBotConfig;
      try { config = WebhookBotConfigSchema.parse(bot.config); } catch { botResults.push({ botId: bot.id, skipped: ['Bot config failed validation'] }); continue; }
      const result = await runBotEvaluation(bot, config, parsed, policy, { deliveryId });
      if (result.status === 'ERROR') failed += 1; else routed += 1;
      botResults.push({ botId: bot.id, accountId: account.id, runId: result.runId, orders: result.orders, skipped: result.skipped, notes: result.notes, price: result.price, positionSide: result.positionSide, ...(result.error ? { error: result.error } : {}) });
      await queueNotification(workspace.id, {
        channel: 'bot',
        severity: result.status === 'ERROR' ? 'WARN' : result.skipped.length > 0 ? 'INFO' : 'INFO',
        title: `Bot ${bot.name} ${result.status === 'ERROR' ? 'errored' : result.orders.length > 0 ? `placed ${result.orders.length} order(s)` : result.skipped.length > 0 ? 'skipped orders' : 'ran'}`,
        message: `${account.exchange.toUpperCase()} ${account.marketType} · ${parsed.symbol} ${parsed.action}${result.status === 'ERROR' && result.error ? ` · ${result.error}` : ''}${result.price ? ` @ ${result.price}` : ''}`,
        payload: { botId: bot.id, runId: result.runId, action: parsed.action, symbol: parsed.symbol, orders: result.orders, skipped: result.skipped, notes: result.notes },
        jobId: `notify:run:${result.runId}`,
      });
    }
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: failed === 0 ? 'DELIVERED' : 'FAILED', error: failed > 0 ? `${failed} bot run(s) failed` : null, processedAt: new Date() } });
    await queueNotification(workspace.id, {
      channel: 'webhook',
      severity: failed > 0 ? 'WARN' : 'INFO',
      title: `Webhook delivery ${failed === 0 ? 'completed' : 'partially failed'}`,
      message: `${routed} bot(s) processed, ${failed} failed`,
      payload: { deliveryId, endpointId: endpoint.id, routed, failed },
      jobId: `notify:delivery:${deliveryId}`,
    });
    return { deliveryId, routed, failed, bots: botResults };
  } catch (error) {
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 500) : String(error), processedAt: new Date() } });
    throw error;
  }
}

async function resyncOrder(job: Job<{ action: 'resync'; orderId: string }>): Promise<Record<string, unknown>> {
  const order = await prisma.orderIntent.findUniqueOrThrow({ where: { id: job.data.orderId }, include: { exchangeAccount: true } });
  if ((TERMINAL_STATES as readonly string[]).includes(order.state)) return { orderId: order.id, status: order.state, changed: false };
  let adapter: ExchangeAdapter | undefined;
  try {
    const session = await connectToAccount(order.exchangeAccount);
    adapter = session.adapter;
    const result = await reconcileOrder(adapter, order);
    return { orderId: order.id, ...result };
  } catch (error) {
    if (error instanceof ExchangeError && error.code === 'NOT_ON_EXCHANGE') return { orderId: order.id, changed: false, note: 'no exchange order id yet' };
    throw error;
  } finally {
    await adapter?.disconnect().catch(() => undefined);
  }
}

async function scanForStaleOrders(): Promise<{ scanned: number }> {
  const stale = await prisma.orderIntent.findMany({ where: { state: { in: [...STALE_STATES] }, exchangeOrderId: { not: null } }, orderBy: { updatedAt: 'asc' }, take: 100, select: { id: true } });
  for (const order of stale) {
    await reconciliationQueue.add('resync', { action: 'resync', orderId: order.id }, { jobId: `resync:${order.id}`, attempts: 2, removeOnComplete: true, removeOnFail: false });
  }
  return { scanned: stale.length };
}

const workers = [
  new Worker('orders', (job) => {
    if (job.name === 'cancel') return cancelOrder(job as Job<{ action: 'cancel'; orderId: string }>);
    if (job.name === 'close-all') return closeAll(job as Job<{ action: 'close-all'; exchangeAccountId: string }>);
    return executeOrder(job as Job<{ action: 'execute'; orderId: string }>);
  }, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 25) }),
  new Worker('webhooks', processWebhook, { connection, concurrency: 10 }),
  new Worker('reconciliation', (job) => {
    if (job.name === 'scan') return scanForStaleOrders();
    return resyncOrder(job as Job<{ action: 'resync'; orderId: string }>);
  }, { connection, concurrency: 5 }),
  new Worker('bots', async (job) => {
    if (job.name === 'run') {
      const { botId, signal } = job.data as { botId: string; signal: TradingViewSignal };
      const bot = await prisma.bot.findFirst({ where: { id: botId, status: 'ACTIVE' }, include: { exchangeAccount: true } });
      if (!bot) return { ok: false, reason: 'bot not found or not active' };
      const parsed = TradingViewSignalSchema.parse(signal);
      const policy = await loadPolicy(bot.workspaceId);
      const result = await runBotEvaluation(bot, WebhookBotConfigSchema.parse(bot.config), parsed, policy);
      await queueNotification(bot.workspaceId, {
        channel: 'bot',
        severity: result.status === 'ERROR' ? 'WARN' : result.skipped.length > 0 ? 'INFO' : 'INFO',
        title: `Bot ${bot.name} run ${result.status === 'ERROR' ? 'errored' : result.orders.length > 0 ? `placed ${result.orders.length} order(s)` : result.skipped.length > 0 ? 'skipped orders' : 'completed'}`,
        message: `${bot.exchangeAccount.exchange.toUpperCase()} ${bot.exchangeAccount.marketType} · ${parsed.symbol} ${parsed.action}`,
        payload: { botId: bot.id, runId: result.runId, action: parsed.action, symbol: parsed.symbol, orders: result.orders, skipped: result.skipped },
        jobId: `notify:run:${result.runId}`,
      });
      return { ok: result.status === 'STOPPED', runId: result.runId, orders: result.orders, skipped: result.skipped, notes: result.notes, error: result.error };
    }
    return { ok: false, reason: `unknown job: ${job.name}` };
  }, { connection, concurrency: 5 }),
  new Worker('notifications', async (job) => {
    if (job.name === 'notify') return createNotification(job as Job<{ workspaceId: string; channel: string; severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'; title: string; message?: string; payload?: unknown }>);
    return { ok: false, reason: `unknown job: ${job.name}` };
  }, { connection, concurrency: 5 }),
];
for (const worker of workers) {
  worker.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, error: error instanceof Error ? error.message : String(error) })));
  worker.on('completed', (job) => console.log(JSON.stringify({ level: 'info', queue: worker.name, jobId: job.id, result: job.returnvalue })));
}
setInterval(() => { void scanForStaleOrders().then((result) => console.log(JSON.stringify({ level: 'info', queue: 'reconciliation', event: 'scan', scanned: result.scanned }))).catch((error) => console.error(JSON.stringify({ level: 'error', queue: 'reconciliation', event: 'scan', error: error instanceof Error ? error.message : String(error) }))); }, Number(process.env.RECONCILIATION_SCAN_MS ?? 30000)).unref();
async function shutdown(): Promise<void> { await Promise.all(workers.map((worker) => worker.close())); await ordersQueue.close(); await reconciliationQueue.close(); await connection.quit(); }
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
console.log(JSON.stringify({ level: 'info', service: 'worker', queues: workers.map((worker) => worker.name), status: 'ready' }));