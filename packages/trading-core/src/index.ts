import { Decimal } from 'decimal.js';
import { minOrderNotionalUsd, type Allocation, type MarketType, type OrderRequest, type PositionSide, type ResolvedOrderRequest } from '@platform/contracts';

export type OrderState = 'RECEIVED'|'VALIDATED'|'RISK_APPROVED'|'QUEUED'|'SUBMITTING'|'ACKNOWLEDGED'|'PARTIALLY_FILLED'|'FILLED'|'CANCEL_PENDING'|'CANCELED'|'REJECTED'|'RECONCILING'|'FAILED';
const transitions: Record<OrderState, OrderState[]> = {
  RECEIVED: ['VALIDATED','REJECTED'], VALIDATED: ['RISK_APPROVED','REJECTED'], RISK_APPROVED: ['QUEUED','REJECTED'], QUEUED: ['SUBMITTING','CANCELED'], SUBMITTING: ['ACKNOWLEDGED','RECONCILING','FAILED'], ACKNOWLEDGED: ['PARTIALLY_FILLED','FILLED','CANCEL_PENDING','RECONCILING'], PARTIALLY_FILLED: ['FILLED','CANCEL_PENDING','RECONCILING'], FILLED: [], CANCEL_PENDING: ['CANCELED','FILLED','RECONCILING'], CANCELED: [], REJECTED: [], RECONCILING: ['ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELED','FAILED'], FAILED: ['RECONCILING']
};
export class OrderStateMachine {
  constructor(public state: OrderState = 'RECEIVED') {}
  transition(next: OrderState): void { if (!transitions[this.state].includes(next)) throw new Error(`Invalid order transition ${this.state} -> ${next}`); this.state = next; }
}

export type PositionSnapshot = { side: PositionSide; quantity: string; averageEntryPrice: string; realizedPnl: string };
export function applyFill(position: PositionSnapshot, fillSide: 'BUY'|'SELL', fillQuantity: string, fillPrice: string): PositionSnapshot {
  const signedCurrent = new Decimal(position.quantity).mul(position.side === 'SHORT' ? -1 : 1);
  const signedFill = new Decimal(fillQuantity).mul(fillSide === 'BUY' ? 1 : -1);
  const next = signedCurrent.add(signedFill);
  const currentPrice = new Decimal(position.averageEntryPrice || '0');
  const price = new Decimal(fillPrice);
  let realized = new Decimal(position.realizedPnl);
  let average = currentPrice;
  const sameDirection = signedCurrent.isZero() || signedCurrent.isPositive() === signedFill.isPositive();
  if (sameDirection) {
    const totalCost = signedCurrent.abs().mul(currentPrice).add(signedFill.abs().mul(price));
    average = next.isZero() ? new Decimal(0) : totalCost.div(next.abs());
  } else {
    const closing = Decimal.min(signedCurrent.abs(), signedFill.abs());
    const direction = signedCurrent.isPositive() ? 1 : -1;
    realized = realized.add(price.minus(currentPrice).mul(closing).mul(direction));
    if (signedFill.abs().greaterThan(signedCurrent.abs())) average = price;
    if (next.isZero()) average = new Decimal(0);
  }
  return { side: next.isNegative() ? 'SHORT' : next.isPositive() ? 'LONG' : 'BOTH', quantity: next.abs().toFixed(), averageEntryPrice: average.toFixed(), realizedPnl: realized.toFixed() };
}
export function unrealizedPnl(position: PositionSnapshot, markPrice: string): string {
  if (position.side === 'BOTH') return '0';
  const direction = position.side === 'LONG' ? 1 : -1;
  return new Decimal(markPrice).minus(position.averageEntryPrice).mul(position.quantity).mul(direction).toFixed();
}
export function buildBracketOrders(entry: ResolvedOrderRequest, stopPrice: string, takeProfits: Array<{ price: string; percentage: string }>): OrderRequest[] {
  const totalPercentage = takeProfits.reduce((sum, item) => sum + Number(item.percentage), 0);
  if (totalPercentage !== 100) throw new Error('Take-profit percentages must total 100');
  const closingSide: OrderRequest['side'] = entry.side === 'BUY' ? 'SELL' : 'BUY';
  const stop: OrderRequest = { ...entry, side: closingSide, type: 'STOP_MARKET', stopPrice, reduceOnly: true, clientOrderId: `${entry.clientOrderId}-sl`, idempotencyKey: `${entry.idempotencyKey}:sl` };
  const takes = takeProfits.map((item, index) => ({ ...entry, side: closingSide, type: 'TAKE_PROFIT_MARKET' as const, stopPrice: item.price, quantity: new Decimal(entry.quantity).mul(item.percentage).div(100).toFixed(), reduceOnly: true, clientOrderId: `${entry.clientOrderId}-tp${index + 1}`, idempotencyKey: `${entry.idempotencyKey}:tp:${index + 1}` }));
  return [entry, stop, ...takes];
}

export type SizeInput = { allocation: Allocation; marketType: MarketType; price: string; equity: string; maxEquity: string; leverage?: number; stopPrice?: string };
export type SizeResult = { ok: boolean; reasons: string[]; quantity?: string; notional?: string; margin?: string; leverage: number };
export function sizeOrder(input: SizeInput): SizeResult {
  const reasons: string[] = [];
  const price = new Decimal(input.price);
  const equity = new Decimal(input.equity);
  const maxEquity = new Decimal(input.maxEquity);
  const minNotional = new Decimal(minOrderNotionalUsd(input.marketType));
  const leverage = Math.max(1, Math.floor(input.leverage ?? 1));
  if (price.lessThanOrEqualTo(0)) reasons.push('Price unavailable for sizing');
  let notional = new Decimal(0);
  if (input.allocation.mode === 'PERCENT_EQUITY') notional = equity.mul(input.allocation.percent).div(100);
  if (input.allocation.mode === 'PERCENT_MAX_EQUITY') notional = maxEquity.mul(input.allocation.percent).div(100);
  if (input.allocation.mode === 'FIXED_AMOUNT') notional = new Decimal(input.allocation.amount);
  if (input.allocation.mode === 'RISK_PERCENT') {
    const stop = input.stopPrice;
    if (!stop) reasons.push('RISK_PERCENT sizing requires a stop price');
    else {
      const riskAmount = equity.mul(input.allocation.percent).div(100);
      const distance = price.sub(stop).abs();
      if (distance.isZero()) reasons.push('Stop price equals entry price');
      else { notional = riskAmount.div(distance).mul(price); }
    }
  }
  if (reasons.length > 0) return { ok: false, reasons, leverage };
  const isLeveraged = input.marketType !== 'SPOT';
  const margin = isLeveraged && notional.greaterThan(0) ? notional.div(leverage) : notional;
  if (isLeveraged && margin.greaterThan(equity)) reasons.push('Order margin exceeds available equity');
  if (notional.lessThan(minNotional)) reasons.push(`Order value below minimum of $${minNotional.toFixed(0)} (${input.marketType})`);
  if (reasons.length > 0) return { ok: false, reasons, leverage };
  const quantity = notional.div(price);
  return { ok: true, reasons: [], quantity: quantity.toFixed(8), notional: notional.toFixed(4), margin: margin.toFixed(4), leverage };
}
