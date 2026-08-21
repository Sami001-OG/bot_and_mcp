import { OrderRequestSchema, type Allocation, type OrderRequest, type ResolvedOrderRequest } from '@platform/contracts';
import { Prisma } from '@platform/database';
import { ExchangeError, type MarketPrecision } from '@platform/exchange-core';
import { evaluateOrder, type RiskContext, type RiskPolicy } from '@platform/risk-engine';
import { alignAmount, alignPrice, sizeOrder } from '@platform/trading-core';
import { getAccountConfig, resolveMarketSnapshot, type AccountConfig } from './account.js';
import { CommandError } from './errors.js';
import { executeOrderNow, persistOrder, type PersistedOrderLike } from './execute.js';
import { dailyRealizedPnl } from './ledger.js';
import { getSettings, requireTradingEnabled } from './settings.js';

export { CommandError };

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

export async function loadPolicy(): Promise<RiskPolicy> {
  return defaultPolicy;
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

export async function parseOrderBody(body: unknown, idempotencyKey?: string, config?: AccountConfig): Promise<OrderRequest> {
  const candidate = (body ?? {}) as { exchangeAccountId?: string; marketType?: string };
  const resolved = config ?? (candidate.exchangeAccountId ? await getAccountConfig(candidate.exchangeAccountId) : await getAccountConfig());
  const withDefaults = {
    ...(body as object),
    exchangeAccountId: resolved.id,
    exchange: resolved.exchange,
    marketType: candidate.marketType?.toUpperCase() ?? resolved.marketType,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey })
  };
  return OrderRequestSchema.parse(withDefaults);
}

export type PlaceOrderInput = {
  request: OrderRequest;
  riskContext?: Partial<Pick<RiskContextInput, 'dailyPnl' | 'weeklyPnl' | 'monthlyPnl' | 'exposure' | 'openPositions' | 'consecutiveLosses' | 'enforceMinimumNotional'>>;
  maxNotionalUsd?: string;
  source?: Record<string, unknown>;
};

export type PlaceOrderResult = {
  accepted: boolean;
  order: OrderIntentLike;
  duplicate?: boolean;
  marketPrice?: string;
  sized?: { quantity: string; notional: string; leverage?: number };
  execution?: { state: string; exchangeOrderId?: string; filled?: number; error?: string };
  risk?: unknown;
};

type OrderIntentLike = { id: string; state: string; symbol: string; side: string; quantity: string };

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const { request } = input;
  await requireTradingEnabled();
  const settings = await getSettings();
  if (settings.dailyLossLimit !== null) {
    const dailyPnl = new Prisma.Decimal(await dailyRealizedPnl());
    if (dailyPnl.lte(new Prisma.Decimal(settings.dailyLossLimit).negated())) {
      throw new CommandError(409, 'DAILY_LOSS_LIMIT_BREACHED', `Daily loss limit reached (${dailyPnl.toFixed(4)} vs limit ${settings.dailyLossLimit})`);
    }
  }
  const accountId = request.exchangeAccountId && request.exchangeAccountId !== 'default' ? request.exchangeAccountId : undefined;
  const config = await getAccountConfig(accountId);
  const isLeveraged = request.marketType !== 'SPOT';
  if (isLeveraged && request.marginMode && request.marginMode !== 'ISOLATED') throw new CommandError(400, 'CROSS_MARGIN_UNSUPPORTED', 'Only ISOLATED margin mode is supported');
  const marginMode: 'ISOLATED' | undefined = isLeveraged ? 'ISOLATED' : undefined;
  let market: { price: string; equity: string; maxEquity: string; precision: MarketPrecision | null };
  try {
    market = await resolveMarketSnapshot(request.symbol, request.price, true, accountId, request.marketType);
  } catch (error) {
    throw new CommandError(503, 'MARKET_UNAVAILABLE', 'Could not resolve live market data for this order', {
      details: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error)
    });
  }
  const isSpotSell = request.marketType === 'SPOT' && request.side === 'SELL';
  if (!request.reduceOnly && !isSpotSell && new Prisma.Decimal(market.equity).lte(0)) {
    const quote = (request.symbol.split('/')[1] ?? 'USDT').split(':')[0] ?? 'USDT';
    throw new CommandError(409, 'INSUFFICIENT_FUNDS', `No funds in the exchange account (${config.label}). Add ${quote} to the account before trading.`);
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
  const policy = await loadPolicy();
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
  const row = await persistOrder(orderLike, {
    ...(effective.leverage === undefined ? {} : { leverage: effective.leverage }),
    ...(marginMode === undefined ? {} : { marginMode }),
    ...(request.allocation ? { allocation: request.allocation } : {}),
    marketType: request.marketType,
    source: { kind: 'manual' }
  });
  if (!row.created) {
    return { accepted: false, order: { id: row.order.id, state: row.order.state, symbol: row.order.symbol, side: row.order.side, quantity: row.order.quantity }, duplicate: true };
  }
  const execution = await executeOrderNow(row.order.id);
  const notional = new Prisma.Decimal(effective.quantity).mul(market.price).toDecimalPlaces(4).toFixed();
  return {
    accepted: true,
    order: { id: row.order.id, state: row.order.state, symbol: row.order.symbol, side: row.order.side, quantity: row.order.quantity },
    marketPrice: market.price,
    ...(request.allocation ? { sized: { quantity: effective.quantity, notional, ...(effective.leverage === undefined ? {} : { leverage: effective.leverage }) } } : {}),
    execution
  };
}

export type { Allocation };