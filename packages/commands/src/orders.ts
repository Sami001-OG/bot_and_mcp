import { OrderRequestSchema, type Allocation, type ExchangeId, type OrderRequest, type ResolvedOrderRequest } from '@platform/contracts';
import { Prisma, encryption, prisma, type ExchangeAccount, type ExchangeCredential, type OrderIntent } from '@platform/database';
import { createExchangeAdapter } from '@platform/exchange-adapters';
import { ExchangeError, type ExchangeAdapter, type ExchangeConnection, type MarketInfo, type MarketPrecision } from '@platform/exchange-core';
import { evaluateOrder, type RiskContext, type RiskPolicy } from '@platform/risk-engine';
import { alignAmount, alignPrice, sizeOrder } from '@platform/trading-core';
import { dailyRealizedPnl } from './ledger.js';

export class CommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export const defaultPolicy: RiskPolicy = {
  maxDailyLoss: '1000',
  maxWeeklyLoss: '3000',
  maxMonthlyLoss: '10000',
  maxDrawdownPercent: '20',
  maxConcurrentPositions: 10,
  maxExposure: '100000',
  maxLeverage: 20,
  maxRiskPerTrade: '500',
  maxPositionSize: '25000',
  consecutiveLossCooldown: 3,
  tradingEnabled: true
};

export async function loadPolicy(workspaceId: string): Promise<RiskPolicy> {
  const row = await prisma.riskPolicy.findUnique({ where: { workspaceId } });
  if (!row) return defaultPolicy;
  return {
    maxDailyLoss: row.maxDailyLoss.toString(),
    maxWeeklyLoss: row.maxWeeklyLoss.toString(),
    maxMonthlyLoss: row.maxMonthlyLoss.toString(),
    maxDrawdownPercent: row.maxDrawdownPercent.toString(),
    maxConcurrentPositions: row.maxConcurrentPositions,
    maxExposure: row.maxExposure.toString(),
    maxLeverage: row.maxLeverage,
    maxRiskPerTrade: row.maxRiskPerTrade.toString(),
    maxPositionSize: row.maxPositionSize.toString(),
    consecutiveLossCooldown: row.consecutiveLossCooldown,
    tradingEnabled: row.tradingEnabled
  };
}

export function decryptCredentials(credential: ExchangeCredential): { apiKey: string; secret: string; passphrase?: string } {
  return JSON.parse(
    encryption.decrypt(
      credential.encryptedPayload as { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string; keyId: string },
      `exchange-credential:${credential.exchangeAccountId}`
    )
  ) as { apiKey: string; secret: string; passphrase?: string };
}

export async function latestCredential(accountId: string): Promise<ExchangeCredential | null> {
  return prisma.exchangeCredential.findFirst({ where: { exchangeAccountId: accountId, revokedAt: null }, orderBy: { version: 'desc' } });
}

export async function connectAccount(account: ExchangeAccount): Promise<{ adapter: ExchangeAdapter; credential: ExchangeCredential; connection: ExchangeConnection }> {
  const credential = await latestCredential(account.id);
  if (!credential) throw new ExchangeError('NO_CREDENTIAL', `${account.label} has no active credential`, false);
  const adapter = createExchangeAdapter(account.exchange.toLowerCase() as ExchangeId, account.marketType);
  try {
    const connection = await adapter.connect(decryptCredentials(credential));
    await prisma.exchangeAccount.update({ where: { id: account.id }, data: { lastConnectedAt: new Date(), credentialStatus: 'VERIFIED' } }).catch(() => undefined);
    return { adapter, credential, connection };
  } catch (error) {
    await adapter.disconnect().catch(() => undefined);
    throw error;
  }
}

export async function resolveMarketSnapshot(account: ExchangeAccount, symbol: string, requestPrice?: string, includePrecision = true): Promise<{ price: string; equity: string; maxEquity: string; precision: MarketPrecision | null }> {
  const { adapter } = await connectAccount(account);
  try {
    const price = requestPrice ?? (await adapter.getPrice(symbol));
    const precision = includePrecision ? await marketPrecisionOf(adapter, symbol) : null;
    const balances = await adapter.getBalance();
    const quote = (symbol.split('/')[1] ?? 'USDT').split(':')[0];
    const balance = balances.find((balance) => balance.asset === quote);
const equity = balance ? balance.total : '0';
    const previousEquity = account.equity === null ? undefined : account.equity.toString();
    const previousPeak = account.peakEquity === null ? undefined : account.peakEquity.toString();
    const peakEquity = previousPeak === undefined ? (previousEquity === undefined ? equity : previousEquity) : Prisma.Decimal.max(previousPeak, equity).toString();
    await prisma.exchangeAccount.update({ where: { id: account.id }, data: { equity: new Prisma.Decimal(equity), peakEquity: new Prisma.Decimal(peakEquity) } });
    return { price, equity, maxEquity: peakEquity, precision };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

const marketPrecisionCache = new Map<string, { expiresAt: number; precision: MarketPrecision | null }>();
const MARKET_PRECISION_TTL_MS = 10 * 60_000;

export async function marketPrecisionOf(adapter: ExchangeAdapter, symbol: string): Promise<MarketPrecision | null> {
  const key = `${adapter.id}|${symbol.toUpperCase()}`;
  const hit = marketPrecisionCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.precision;
  let precision: MarketPrecision | null = null;
  try {
    const markets: MarketInfo[] = await adapter.getMarkets().catch(() => []);
    const match = markets.find((market) => market.symbol.toUpperCase() === symbol.toUpperCase());
    if (match) precision = { ...(match.amountStep !== undefined ? { amountStep: match.amountStep } : {}), ...(match.amountMin !== undefined ? { amountMin: match.amountMin } : {}), ...(match.priceStep !== undefined ? { priceStep: match.priceStep } : {}), ...(match.priceMin !== undefined ? { priceMin: match.priceMin } : {}) };
  } catch { /* precision is advisory; order flow continues unaligned */ }
  marketPrecisionCache.set(key, { expiresAt: Date.now() + MARKET_PRECISION_TTL_MS, precision });
  return precision;
}

export type RiskContextInput = {
  equity: string;
  peakEquity: string;
  markPrice: string;
  dailyPnl?: string;
  weeklyPnl?: string;
  monthlyPnl?: string;
  exposure?: string;
  openPositions?: number;
  consecutiveLosses?: number;
  enforceMinimumNotional?: boolean;
};

export function buildRiskContext(input: RiskContextInput): RiskContext {
  const context: RiskContext = {
    equity: input.equity,
    dailyPnl: input.dailyPnl ?? '0',
    weeklyPnl: input.weeklyPnl ?? '0',
    monthlyPnl: input.monthlyPnl ?? '0',
    peakEquity: input.peakEquity,
    exposure: input.exposure ?? '0',
    openPositions: input.openPositions ?? 0,
    consecutiveLosses: input.consecutiveLosses ?? 0,
    markPrice: input.markPrice
  };
  if (input.enforceMinimumNotional !== undefined) context.enforceMinimumNotional = input.enforceMinimumNotional;
  return context;
}

export type PersistedOrderLike = {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  type: string;
  quantity: string;
  price?: string;
  stopPrice?: string;
  reduceOnly: boolean;
  postOnly: boolean;
  clientOrderId: string;
  idempotencyKey: string;
};

export type PersistOrderOptions = {
  state?: OrderIntent['state'];
  leverage?: number;
  marginMode?: 'ISOLATED' | 'CROSS';
  allocation?: Allocation;
};

export async function persistOrder(order: PersistedOrderLike, account: ExchangeAccount, options: PersistOrderOptions = {}): Promise<{ order: OrderIntent; created: boolean }> {
  try {
    const orderIntent = await prisma.orderIntent.create({
      data: {
        workspaceId: account.workspaceId,
        exchangeAccountId: account.id,
        idempotencyKey: order.idempotencyKey,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        orderType: order.type,
        marketType: account.marketType,
        quantity: new Prisma.Decimal(order.quantity),
        ...(order.price ? { price: new Prisma.Decimal(order.price) } : {}),
        ...(order.stopPrice ? { stopPrice: new Prisma.Decimal(order.stopPrice) } : {}),
        ...(options.leverage !== undefined ? { leverage: options.leverage } : {}),
        ...(options.marginMode ? { marginMode: options.marginMode } : {}),
        ...(options.allocation ? { allocation: options.allocation as unknown as Prisma.InputJsonValue } : {}),
        reduceOnly: order.reduceOnly,
        postOnly: order.postOnly,
        state: options.state ?? 'QUEUED'
      }
    });
    return { order: orderIntent, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.orderIntent.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: account.workspaceId, idempotencyKey: order.idempotencyKey } } });
      if (existing) return { order: existing, created: false };
    }
    throw error;
  }
}

export function parseOrderBody(body: unknown, idempotencyKey?: string): OrderRequest {
  return OrderRequestSchema.parse({ ...(body as object), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
}

export type PlaceOrderInput = {
  workspaceId: string;
  request: OrderRequest;
  enqueue: (orderId: string) => Promise<void>;
  riskContext?: Partial<Pick<RiskContextInput, 'dailyPnl' | 'weeklyPnl' | 'monthlyPnl' | 'exposure' | 'openPositions' | 'consecutiveLosses' | 'enforceMinimumNotional'>>;
  maxNotionalUsd?: string;
};

export type PlaceOrderResult =
  | { accepted: true; state: 'QUEUED'; id: string; order: OrderIntent; risk: ReturnType<typeof evaluateOrder>; marketPrice: string; sized?: { quantity: string; notional: string; leverage?: number }; queuedAt: string }
  | { accepted: false; state: string; id: string | undefined; duplicate: true; order?: OrderIntent };

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const { workspaceId, request, enqueue } = input;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { liveTradingEnabled: true, dailyLossLimit: true } });
  if (!workspace?.liveTradingEnabled) throw new CommandError(409, 'LIVE_TRADING_DISABLED', 'Live trading is disabled for this workspace');
  if (workspace.dailyLossLimit !== null) {
    const dailyPnl = new Prisma.Decimal(await dailyRealizedPnl(workspaceId));
    if (dailyPnl.lte(workspace.dailyLossLimit.negated())) {
      throw new CommandError(409, 'DAILY_LOSS_LIMIT_BREACHED', `Daily loss limit reached (${dailyPnl.toFixed(4)} vs limit ${workspace.dailyLossLimit.toFixed(4)})`);
    }
  }
  const account = await prisma.exchangeAccount.findUnique({ where: { id: request.exchangeAccountId } });
  if (!account || account.workspaceId !== workspaceId) throw new CommandError(404, 'ACCOUNT_NOT_FOUND', 'Exchange account not found');
  if (!account.tradingEnabled) throw new CommandError(409, 'ACCOUNT_TRADING_DISABLED', 'Trading is disabled for this exchange account');
  if (account.marketType !== request.marketType) throw new CommandError(400, 'MARKET_TYPE_MISMATCH', `Account is ${account.marketType}, request is ${request.marketType}`);
  const isLeveraged = account.marketType !== 'SPOT';
  if (isLeveraged && request.marginMode && request.marginMode !== 'ISOLATED') throw new CommandError(400, 'CROSS_MARGIN_UNSUPPORTED', 'Only ISOLATED margin mode is supported');
  const marginMode: 'ISOLATED' | undefined = isLeveraged ? 'ISOLATED' : undefined;
  let market: { price: string; equity: string; maxEquity: string; precision: MarketPrecision | null };
  try {
    market = await resolveMarketSnapshot(account, request.symbol, request.price);
  } catch (error) {
    throw new CommandError(503, 'MARKET_UNAVAILABLE', 'Could not resolve live market data for this order', {
      details: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error)
    });
  }
  const precision = market.precision;
  let effective: ResolvedOrderRequest;
  if (request.allocation) {
    const allocation = request.allocation;
    const sized = sizeOrder({
      allocation,
      marketType: request.marketType,
      price: market.price,
      equity: market.equity,
      maxEquity: market.maxEquity,
      ...(request.leverage == null ? {} : { leverage: request.leverage }),
      ...(request.stopPrice ? { stopPrice: request.stopPrice } : {}),
      ...(precision ? { precision } : {}),
      ...(request.reduceOnly ? { skipMinimum: true } : {})
    });
    if (!sized.ok || sized.quantity === undefined) {
      throw new CommandError(409, 'SIZING_REJECTED', 'Order rejected by sizing engine', { reasons: sized.reasons, allocation });
    }
    effective = { ...request, quantity: sized.quantity, leverage: sized.leverage };
  } else {
    effective = request as ResolvedOrderRequest;
    if (precision && !request.reduceOnly) {
      const amountMin = precision.amountMin;
      if (amountMin !== undefined && Number.isFinite(amountMin) && amountMin > 0 && new Prisma.Decimal(effective.quantity).lessThan(new Prisma.Decimal(amountMin))) {
        throw new CommandError(409, 'PRECISION_REJECTED', 'Order quantity is below the exchange minimum', { quantity: effective.quantity, amountMin, symbol: effective.symbol });
      }
    }
    const alignedQuantity = alignAmount(effective.quantity, precision ?? undefined);
    if (alignedQuantity !== effective.quantity) effective = { ...effective, quantity: alignedQuantity };
  }
  if (precision) {
    const snappedPrice = effective.price === undefined ? undefined : alignPrice(effective.price, precision);
    const snappedStop = effective.stopPrice === undefined ? undefined : alignPrice(effective.stopPrice, precision);
    if (snappedPrice !== effective.price || snappedStop !== effective.stopPrice) {
      effective = { ...effective, ...(snappedPrice === undefined ? {} : { price: snappedPrice }), ...(snappedStop === undefined ? {} : { stopPrice: snappedStop }) };
    }
  }
  const policy = await loadPolicy(workspaceId);
  const risk = evaluateOrder(
    effective,
    policy,
    buildRiskContext({ equity: market.equity, peakEquity: market.maxEquity, markPrice: market.price, ...(input.riskContext ?? {}) })
  );
  if (!risk.approved) {
    throw new CommandError(409, 'RISK_DENIED', 'Order rejected by risk engine', { risk, allocation: request.allocation });
  }
  if (input.maxNotionalUsd !== undefined) {
    const notional = new Prisma.Decimal(effective.quantity).mul(new Prisma.Decimal(market.price));
    if (notional.gt(new Prisma.Decimal(input.maxNotionalUsd))) {
      throw new CommandError(409, 'MAX_NOTIONAL_EXCEEDED', 'Order notional exceeds the configured limit', { notional: notional.toFixed(4), maxNotionalUsd: new Prisma.Decimal(input.maxNotionalUsd).toFixed(4) });
    }
  }
  const orderLike: PersistedOrderLike = {
    symbol: effective.symbol,
    side: effective.side,
    positionSide: effective.positionSide,
    type: effective.type,
    quantity: effective.quantity,
    ...(effective.price === undefined ? {} : { price: effective.price }),
    ...(effective.stopPrice === undefined ? {} : { stopPrice: effective.stopPrice }),
    reduceOnly: effective.reduceOnly,
    postOnly: effective.postOnly,
    clientOrderId: effective.clientOrderId,
    idempotencyKey: effective.idempotencyKey
  };
  const row = await persistOrder(orderLike, account, {
    ...(effective.leverage === undefined ? {} : { leverage: effective.leverage }),
    ...(marginMode === undefined ? {} : { marginMode }),
    ...(request.allocation ? { allocation: request.allocation } : {})
  });
  if (row.created) await enqueue(row.order.id);
  if (!row.created) {
    return { accepted: false, state: row.order.state, id: row.order.id, duplicate: true, order: row.order };
  }
  const notional = new Prisma.Decimal(effective.quantity).mul(market.price).toDecimalPlaces(4).toFixed();
  return {
    accepted: true,
    state: 'QUEUED',
    id: row.order.id,
    order: row.order,
    risk,
    marketPrice: market.price,
    ...(request.allocation ? { sized: { quantity: effective.quantity, notional, ...(effective.leverage === undefined ? {} : { leverage: effective.leverage }) } } : {}),
    queuedAt: new Date().toISOString()
  };
}

export type CancelOrderInput = { workspaceId: string; orderId: string; enqueue: (orderId: string) => Promise<void> };

export async function cancelOrderCommand(input: CancelOrderInput): Promise<{ accepted: true; orderId: string; state: 'CANCEL_PENDING' }> {
  const { workspaceId, orderId, enqueue } = input;
  const order = await prisma.orderIntent.findFirst({ where: { id: orderId, workspaceId } });
  if (!order) throw new CommandError(404, 'ORDER_NOT_FOUND', 'Order not found');
  if (!['QUEUED', 'ACKNOWLEDGED', 'SUBMITTING', 'PARTIALLY_FILLED'].includes(order.state)) {
    throw new CommandError(409, 'ORDER_NOT_CANCELABLE', `Order is ${order.state} and cannot be canceled`);
  }
  await prisma.orderIntent.update({ where: { id: orderId }, data: { state: 'CANCEL_PENDING' } });
  await enqueue(orderId);
  return { accepted: true, orderId, state: 'CANCEL_PENDING' };
}

export type CloseAllInput = { workspaceId: string; exchangeAccountId?: string; enqueue: (exchangeAccountId: string) => Promise<void> };

export async function closeAllCommand(input: CloseAllInput): Promise<{ accepted: true; operation: 'CLOSE_ALL_POSITIONS'; exchangeAccountIds: string[]; queuedAt: string }> {
  const { workspaceId, enqueue } = input;
  const where = { workspaceId, ...(input.exchangeAccountId ? { id: input.exchangeAccountId } : {}) };
  const accounts = await prisma.exchangeAccount.findMany({ where });
  if (accounts.length === 0) throw new CommandError(404, 'ACCOUNT_NOT_FOUND', 'Exchange account not found');
  for (const account of accounts) await enqueue(account.id);
  return { accepted: true, operation: 'CLOSE_ALL_POSITIONS', exchangeAccountIds: accounts.map((account) => account.id), queuedAt: new Date().toISOString() };
}
