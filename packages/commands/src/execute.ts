import { prisma, Prisma, type OrderIntent } from '@platform/database';
import { ExchangeError, type ExchangeAdapter, type ExchangeOrder } from '@platform/exchange-core';
import { OrderRequestSchema, type Allocation, type ResolvedOrderRequest } from '@platform/contracts';
import { sizeOrder, applyFill, alignAmount, alignPrice, type PositionSnapshot } from '@platform/trading-core';
import { connectToAccount, getAccountConfig, marketPrecisionOf } from './account.js';
import { getSettings } from './settings.js';
import { syncPositionsFromExchange } from './ledger.js';
import { CommandError } from './errors.js';

export const TERMINAL_STATES = ['FILLED', 'CANCELED', 'REJECTED', 'FAILED'] as const;

export async function setState(id: string, state: OrderIntent['state'], rejectionReason?: string): Promise<void> {
  await prisma.orderIntent.update({ where: { id }, data: { state, ...(rejectionReason === undefined ? {} : { rejectionReason }) } });
}

export async function filledQuantityOf(orderId: string): Promise<number> {
  const rows = await prisma.execution.findMany({ where: { orderIntentId: orderId }, select: { quantity: true } });
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

export async function updatePositionLedger(order: OrderIntent, quantity: string, price: string, fee: string): Promise<void> {
  if (order.marketType === 'SPOT') return;
  const existing = await prisma.position.findFirst({ where: { symbol: order.symbol, ...(order.positionSide === 'BOTH' ? {} : { side: order.positionSide }) } });
  const base: PositionSnapshot = existing ? { side: existing.side as PositionSnapshot['side'], quantity: existing.quantity, averageEntryPrice: existing.averageEntryPrice, realizedPnl: existing.realizedPnl } : { side: 'BOTH', quantity: '0', averageEntryPrice: '0', realizedPnl: '0' };
  const next = applyFill(base, order.side as 'BUY' | 'SELL', quantity, price);
  const realizedPnl = new Prisma.Decimal(next.realizedPnl).sub(new Prisma.Decimal(fee)).toFixed(18);
  if (next.quantity === '0' || next.quantity === '0.000000000000000000') {
    await prisma.position.deleteMany({ where: { symbol: order.symbol, ...(order.positionSide === 'BOTH' ? {} : { side: order.positionSide }) } });
    return;
  }
  if (existing && existing.side !== next.side) {
    const conflict = await prisma.position.findUnique({ where: { symbol_side: { symbol: order.symbol, side: next.side } } });
    if (conflict) {
      await prisma.position.update({ where: { id: conflict.id }, data: { quantity: next.quantity, averageEntryPrice: next.averageEntryPrice, realizedPnl: new Prisma.Decimal(conflict.realizedPnl).add(new Prisma.Decimal(realizedPnl)).toFixed(18) } });
    }
    await prisma.position.delete({ where: { id: existing.id } });
    if (conflict) return;
  }
  await prisma.position.upsert({
    where: { symbol_side: { symbol: order.symbol, side: next.side } },
    update: { quantity: next.quantity, averageEntryPrice: next.averageEntryPrice, realizedPnl },
    create: { symbol: order.symbol, side: next.side, marginMode: order.marginMode ?? 'ISOLATED', quantity: next.quantity, averageEntryPrice: next.averageEntryPrice, markPrice: price, leverage: order.leverage ?? 1, unrealizedPnl: '0', realizedPnl },
  });
}

export async function recordExecution(order: OrderIntent, exchangeOrder: ExchangeOrder, fillFraction: number, recordedFilled: number): Promise<void> {
  const quantity = new Prisma.Decimal(Number(exchangeOrder.filledQuantity) * fillFraction).toFixed(18);
  const price = (exchangeOrder.averagePrice ?? exchangeOrder.quantity) as string;
  const fee = exchangeOrder.fee ? new Prisma.Decimal(exchangeOrder.fee.cost).mul(new Prisma.Decimal(fillFraction)).toFixed(18) : '0';
  const feeAsset = exchangeOrder.fee?.asset ?? null;
  await prisma.execution.create({ data: { orderIntentId: order.id, exchangeExecutionId: recordedFilled === 0 ? exchangeOrder.id : `${exchangeOrder.id}:${recordedFilled}`, quantity, price, fee, ...(feeAsset ? { feeAsset } : {}), executedAt: new Date() } });
  await updatePositionLedger(order, quantity, price, fee).catch((error) => console.error(JSON.stringify({ level: 'error', event: 'position-ledger', orderId: order.id, error: error instanceof Error ? error.message : String(error) })));
}

export function reconcileStatus(exchangeOrder: ExchangeOrder): { state: OrderIntent['state']; rejectionReason?: string } {
  switch (exchangeOrder.status) {
    case 'FILLED': return { state: 'FILLED' };
    case 'PARTIALLY_FILLED': return { state: 'PARTIALLY_FILLED' };
    case 'CANCELED': return { state: 'CANCELED' };
    case 'EXPIRED': return { state: 'CANCELED', rejectionReason: 'EXPIRED' };
    case 'REJECTED': return { state: 'REJECTED', rejectionReason: 'REJECTED' };
    default: return { state: 'ACKNOWLEDGED' };
  }
}

export async function reconcileOrder(adapter: ExchangeAdapter, order: OrderIntent): Promise<{ status: ExchangeOrder['status']; changed: boolean; recordedDelta: number }> {
  if (!order.exchangeOrderId) throw new ExchangeError('NOT_ON_EXCHANGE', 'Order has no exchange order id', false);
  let exchangeOrder: ExchangeOrder;
  try {
    exchangeOrder = await adapter.getOrder(order.exchangeOrderId, order.symbol);
  } catch (error) {
    if (error instanceof ExchangeError && (error.code === 'OrderNotFound' || /order.*(not found|does not exist)/i.test(error.message))) {
      await setState(order.id, 'CANCELED', 'NOT_FOUND_ON_EXCHANGE');
      return { status: 'CANCELED', changed: order.state !== 'CANCELED', recordedDelta: 0 };
    }
    throw error;
  }
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

export async function recoverOrderByClientOrderId(adapter: ExchangeAdapter, order: OrderIntent): Promise<{ recovered: boolean; exchangeOrder?: ExchangeOrder }> {
  let existing: ExchangeOrder | null;
  try {
    existing = await adapter.findOrderByClientOrderId(order.clientOrderId, order.symbol);
  } catch (error) {
    throw new ExchangeError('LOOKUP_FAILED', `Failed to look up order by clientOrderId: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (!existing) return { recovered: false };
  try {
    await prisma.orderIntent.update({ where: { id: order.id }, data: { exchangeOrderId: existing.id } });
    const recordedFilled = Number(existing.filledQuantity ?? 0);
    if (recordedFilled > 0) await recordExecution(order, existing, 1, 0);
    const target = reconcileStatus(existing);
    await setState(order.id, target.state, target.rejectionReason);
  } catch (error) {
    throw new ExchangeError('DB_WRITE_FAILED', `Failed to persist recovered order: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  return { recovered: true, exchangeOrder: existing };
}

const MAX_EXECUTE_ATTEMPTS = 5;

export type ExecuteResult = { orderId: string; state: OrderIntent['state']; exchangeOrderId?: string; filled?: number; error?: string; skipped?: boolean };

export async function executeOrderNow(orderId: string): Promise<ExecuteResult> {
  const order = await prisma.orderIntent.findUniqueOrThrow({ where: { id: orderId } });
  if ((TERMINAL_STATES as readonly string[]).includes(order.state)) return { orderId, state: order.state, skipped: true };
  const settings = await getSettings();
  if (!settings.tradingEnabled) {
    await setState(orderId, 'REJECTED', 'LIVE_TRADING_DISABLED');
    return { orderId, state: 'REJECTED', error: 'LIVE_TRADING_DISABLED' };
  }
  const config = await getAccountConfig(order.exchangeAccountId ?? undefined);
  const marketType = (order.marketType ?? config.marketType).toUpperCase() as 'SPOT' | 'USDT_FUTURES';
  let submitted = false;
  let attempt = 0;
  while (true) {
    let adapter: ExchangeAdapter | undefined;
    try {
      const session = await connectToAccount(order.exchangeAccountId ?? undefined, marketType);
      adapter = session.adapter;
      if (order.exchangeOrderId) {
        const result = await reconcileOrder(adapter, order);
        return { orderId, state: order.state, exchangeOrderId: order.exchangeOrderId, filled: Number(await filledQuantityOf(orderId)) };
      }
      if (order.state === 'SUBMITTING') {
        const recovered = await recoverOrderByClientOrderId(adapter, order);
        if (recovered.recovered && recovered.exchangeOrder) {
          return { orderId, state: order.state, exchangeOrderId: recovered.exchangeOrder.id, filled: Number(recovered.exchangeOrder.filledQuantity ?? 0) };
        }
      }
      try {
        await setState(order.id, 'SUBMITTING');
      } catch (error) {
        throw new ExchangeError('DB_WRITE_FAILED', `Failed to persist SUBMITTING state: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      submitted = true;
      let quantity = order.quantity;
      const precision = await marketPrecisionOf(adapter, order.symbol).catch(() => null);
      if (order.allocation) {
        const price = order.price ?? (await adapter.getPrice(order.symbol));
        const balances = await adapter.getBalance();
        const quote = (order.symbol.split('/')[1] ?? 'USDT').split(':')[0];
        const balance = balances.find((entry) => entry.asset === quote);
        const equity = balance ? balance.total : '0';
        const settingsRow = await getSettings();
        const maxEquity = settingsRow.peakEquity ?? equity;
        const sized = sizeOrder({
          allocation: order.allocation as unknown as Allocation,
          marketType: order.marketType as never,
          price,
          equity,
          maxEquity,
          ...(order.leverage == null ? {} : { leverage: order.leverage }),
          ...(order.stopPrice ? { stopPrice: order.stopPrice } : {}),
          ...(precision ? { precision } : {}),
          ...(order.reduceOnly ? { skipMinimum: true } : {})
        });
        if (!sized.ok || sized.quantity === undefined) {
          await setState(order.id, 'REJECTED', `SIZING:${sized.reasons.join(';')}`);
          return { orderId, state: 'REJECTED', error: `SIZING:${sized.reasons.join(';')}` };
        }
        quantity = sized.quantity;
        if (quantity !== order.quantity || (order.leverage === null || order.leverage !== sized.leverage)) {
          await prisma.orderIntent.update({ where: { id: order.id }, data: { quantity, ...(order.leverage === null || order.leverage !== sized.leverage ? { leverage: sized.leverage } : {}) } });
        }
      }
      if (!order.reduceOnly && precision?.amountMin !== undefined && Number.isFinite(precision.amountMin) && precision.amountMin > 0 && new Prisma.Decimal(quantity).lessThan(new Prisma.Decimal(precision.amountMin))) {
        await setState(order.id, 'REJECTED', `PRECISION:quantity ${quantity} below exchange minimum ${precision.amountMin}`);
        return { orderId, state: 'REJECTED', error: `Quantity ${quantity} is below the exchange minimum of ${precision.amountMin}` };
      }
      const alignedQuantity = alignAmount(quantity, precision ?? undefined);
      if (alignedQuantity !== quantity) {
        quantity = alignedQuantity;
        await prisma.orderIntent.update({ where: { id: order.id }, data: { quantity } });
      }
      const snappedPrice = precision && order.price !== null ? alignPrice(order.price, precision) : order.price;
      const snappedStop = precision && order.stopPrice !== null ? alignPrice(order.stopPrice, precision) : order.stopPrice;
      if (marketType !== 'SPOT') {
        await adapter.setMarginMode(order.symbol, (order.marginMode ?? 'ISOLATED') as 'ISOLATED').catch(() => undefined);
      }
      if (marketType !== 'SPOT' && order.leverage) {
        await adapter.setLeverage(order.symbol, order.leverage).catch(() => undefined);
      }
      const request = OrderRequestSchema.parse({
        exchangeAccountId: order.exchangeAccountId ?? 'default',
        exchange: config.exchange,
        marketType,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        type: order.orderType,
        quantity,
        ...(snappedPrice == null ? {} : { price: snappedPrice }),
        ...(snappedStop == null ? {} : { stopPrice: snappedStop }),
        ...(order.callbackRate ? { callbackRate: order.callbackRate } : {}),
        reduceOnly: order.reduceOnly,
        postOnly: order.postOnly,
        clientOrderId: order.clientOrderId,
        idempotencyKey: order.idempotencyKey
      }) as ResolvedOrderRequest;
      const exchangeOrder = await adapter.placeOrder(request);
      try {
        await prisma.orderIntent.update({ where: { id: order.id }, data: { exchangeOrderId: exchangeOrder.id } });
      } catch (error) {
        throw new ExchangeError('DB_WRITE_FAILED', `Failed to persist exchangeOrderId: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      let resolved: ExchangeOrder = exchangeOrder;
      if (!['FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELED'].includes(exchangeOrder.status)) {
        for (let poll = 0; poll < 8; poll++) {
          if (poll > 0) await new Promise((resolve) => setTimeout(resolve, 250));
          try { resolved = await adapter.getOrder(exchangeOrder.id, order.symbol); } catch { break; }
          if (resolved.status === 'FILLED' || resolved.status === 'PARTIALLY_FILLED' || Number(resolved.filledQuantity ?? 0) > 0) break;
        }
      }
      const recordedFilled = Number(resolved.filledQuantity ?? 0);
      if (resolved.status === 'FILLED' || resolved.status === 'PARTIALLY_FILLED' || (resolved.status === 'NEW' && recordedFilled > 0)) {
        try {
          await recordExecution(order, resolved, 1, 0);
        } catch (error) {
          throw new ExchangeError('DB_WRITE_FAILED', `Failed to record execution: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      const finalState = resolved.status === 'FILLED' ? 'FILLED' : resolved.status === 'PARTIALLY_FILLED' || (resolved.status === 'NEW' && recordedFilled > 0) ? 'PARTIALLY_FILLED' : resolved.status === 'REJECTED' ? 'REJECTED' : resolved.status === 'CANCELED' ? 'CANCELED' : 'ACKNOWLEDGED';
      try {
        await setState(order.id, finalState, resolved.status === 'REJECTED' ? resolved.rawStatus : undefined);
      } catch (error) {
        throw new ExchangeError('DB_WRITE_FAILED', `Failed to persist final state: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      return { orderId, state: finalState, exchangeOrderId: exchangeOrder.id, filled: recordedFilled };
    } catch (error) {
      const exchangeError = error instanceof ExchangeError ? error : new ExchangeError('INTERNAL', error instanceof Error ? error.message : String(error), false);
      const canRetry = exchangeError.retryable && attempt < MAX_EXECUTE_ATTEMPTS - 1;
      if (canRetry) {
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
        continue;
      }
      const finalState = exchangeError.retryable ? 'FAILED' : 'REJECTED';
      await setState(order.id, finalState, exchangeError.code);
      if (submitted) {
        await resyncOrderNow(order.id).catch(() => undefined);
      }
      return { orderId, state: finalState, error: exchangeError.code };
    } finally {
      await adapter?.disconnect().catch(() => undefined);
    }
  }
}

export async function cancelOrderNow(orderId: string): Promise<{ orderId: string; state: OrderIntent['state']; exchangeOrderId?: string; error?: string }> {
  const order = await prisma.orderIntent.findUniqueOrThrow({ where: { id: orderId } });
  if ((TERMINAL_STATES as readonly string[]).includes(order.state)) return { orderId, state: order.state };
  let adapter: ExchangeAdapter | undefined;
  try {
    const session = await connectToAccount(order.exchangeAccountId ?? undefined);
    adapter = session.adapter;
    if (!order.exchangeOrderId) throw new ExchangeError('NOT_ON_EXCHANGE', 'Order has no exchange order id', false);
    const result = await adapter.cancelOrder(order.exchangeOrderId, order.symbol);
    if (result.status === 'FILLED') {
      await reconcileOrder(adapter, order);
      return { orderId, state: order.state, exchangeOrderId: order.exchangeOrderId };
    }
    await setState(order.id, 'CANCELED');
    return { orderId, state: 'CANCELED', exchangeOrderId: order.exchangeOrderId };
  } catch (error) {
    const exchangeError = error instanceof ExchangeError ? error : new ExchangeError('INTERNAL', error instanceof Error ? error.message : String(error), false);
    await setState(order.id, exchangeError.retryable ? 'FAILED' : 'REJECTED', exchangeError.code);
    return { orderId, state: exchangeError.retryable ? 'FAILED' : 'REJECTED', error: exchangeError.code };
  } finally {
    await adapter?.disconnect().catch(() => undefined);
  }
}

export type CloseAllResult = { canceled: number; cancelFailures: string[]; dbOrdersCanceled: number; positionsToClose: number; closed: number; closeFailures: string[] };

export async function closeAllNow(accountId?: string): Promise<CloseAllResult> {
  let adapter: ExchangeAdapter | undefined;
  try {
    const session = await connectToAccount(accountId);
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
    const affected = await prisma.orderIntent.updateMany({ where: { state: { in: ['ACKNOWLEDGED', 'QUEUED', 'SUBMITTING', 'PARTIALLY_FILLED', 'CANCEL_PENDING'] } }, data: { state: 'CANCELED' } });
    const positions = await adapter.getPositions();
    const closeFailures: string[] = [];
    let closed = 0;
    for (const position of positions) {
      const opposite: 'BUY' | 'SELL' = position.side === 'LONG' ? 'SELL' : 'BUY';
      const idempotencyKey = `close-${position.symbol}-${Date.now()}-${closed}`;
      const clientOrderId = `close-${Date.now()}-${closed}`;
      try {
        const { order, created } = await persistOrder({ symbol: position.symbol, side: opposite, positionSide: 'BOTH', type: 'MARKET', quantity: position.quantity, reduceOnly: true, postOnly: false, clientOrderId, idempotencyKey }, { state: 'QUEUED', ...(accountId ? { exchangeAccountId: accountId } : {}) });
        if (created) await executeOrderNow(order.id);
        closed += 1;
      } catch (error) {
        closeFailures.push(`${position.symbol}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      }
    }
    return { canceled, cancelFailures, dbOrdersCanceled: affected.count, positionsToClose: positions.length, closed, closeFailures };
  } catch (error) {
    throw error;
  } finally {
    await adapter?.disconnect().catch(() => undefined);
  }
}

export async function resyncOrderNow(orderId: string): Promise<Record<string, unknown>> {
  const order = await prisma.orderIntent.findUniqueOrThrow({ where: { id: orderId } });
  if ((['FILLED', 'CANCELED', 'REJECTED'] as string[]).includes(order.state)) return { orderId, status: order.state, changed: false };
  let adapter: ExchangeAdapter | undefined;
  try {
    const session = await connectToAccount(order.exchangeAccountId ?? undefined);
    adapter = session.adapter;
    if (order.exchangeOrderId) {
      const result = await reconcileOrder(adapter, order);
      return { orderId, ...result };
    }
    if (order.state === 'SUBMITTING' || order.state === 'FAILED') {
      const recovered = await recoverOrderByClientOrderId(adapter, order);
      if (recovered.recovered && recovered.exchangeOrder) {
        return { orderId, exchangeOrderId: recovered.exchangeOrder.id, status: recovered.exchangeOrder.status, reconciled: true, changed: true };
      }
      return { orderId, changed: false, note: 'no matching order on exchange by clientOrderId' };
    }
    return { orderId, changed: false, note: 'no exchange order id yet' };
  } catch (error) {
    if (error instanceof ExchangeError && error.code === 'NOT_ON_EXCHANGE') return { orderId, changed: false, note: 'no exchange order id yet' };
    throw error;
  } finally {
    await adapter?.disconnect().catch(() => undefined);
  }
}

export async function scanForStaleOrders(): Promise<{ scanned: number; resynced: number }> {
  const stale = await prisma.orderIntent.findMany({ where: { state: { in: ['SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'FAILED'] }, OR: [{ exchangeOrderId: { not: null } }, { state: 'SUBMITTING' }] }, orderBy: { updatedAt: 'asc' }, take: 100, select: { id: true } });
  let resynced = 0;
  for (const order of stale) {
    try {
      await resyncOrderNow(order.id);
      resynced += 1;
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'resync', orderId: order.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { scanned: stale.length, resynced };
}

export async function syncPositionsNow(): Promise<{ positions: Array<{ symbol: string; side: string }> }> {
  const result = await syncPositionsFromExchange();
  return { positions: result.positions.map((position) => ({ symbol: position.symbol, side: position.side })) };
}

export type PersistedOrderLike = {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  type: string;
  quantity: string;
  price?: string;
  stopPrice?: string;
  callbackRate?: string;
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
  marketType?: string;
  source?: Record<string, unknown>;
  exchangeAccountId?: string;
};

export async function persistOrder(order: PersistedOrderLike, options: PersistOrderOptions = {}): Promise<{ order: OrderIntent; created: boolean }> {
  const config = await getAccountConfig(options.exchangeAccountId ?? undefined);
  try {
    const orderIntent = await prisma.orderIntent.create({
      data: {
        idempotencyKey: order.idempotencyKey,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        orderType: order.type,
        marketType: options.marketType ?? config.marketType,
        exchangeAccountId: config.id,
        quantity: order.quantity,
        ...(order.price ? { price: order.price } : {}),
        ...(order.stopPrice ? { stopPrice: order.stopPrice } : {}),
        ...(order.callbackRate ? { callbackRate: order.callbackRate } : {}),
        ...(options.leverage !== undefined ? { leverage: options.leverage } : {}),
        ...(options.marginMode ? { marginMode: options.marginMode } : {}),
        ...(options.allocation ? { allocation: options.allocation as unknown as Prisma.InputJsonValue } : {}),
        ...(options.source ? { source: options.source as unknown as Prisma.InputJsonValue } : {}),
        reduceOnly: order.reduceOnly,
        postOnly: order.postOnly,
        state: options.state ?? 'QUEUED'
      }
    });
    return { order: orderIntent, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.orderIntent.findUnique({ where: { idempotencyKey: order.idempotencyKey } });
      if (existing) return { order: existing, created: false };
    }
    throw error;
  }
}

export function isOrderCancelable(state: string): boolean {
  return ['QUEUED', 'ACKNOWLEDGED', 'SUBMITTING', 'PARTIALLY_FILLED'].includes(state);
}

export async function cancelOrderCommand(orderId: string): Promise<{ accepted: true; orderId: string; state: string }> {
  const order = await prisma.orderIntent.findUnique({ where: { id: orderId } });
  if (!order) throw new CommandError(404, 'ORDER_NOT_FOUND', 'Order not found');
  if (!isOrderCancelable(order.state)) {
    throw new CommandError(409, 'ORDER_NOT_CANCELABLE', `Order is ${order.state} and cannot be canceled`);
  }
  await setState(orderId, 'CANCEL_PENDING');
  await cancelOrderNow(orderId);
  return { accepted: true, orderId, state: 'CANCEL_PENDING' };
}