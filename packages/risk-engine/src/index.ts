import { Decimal } from 'decimal.js';
import { minOrderNotionalUsd, type ResolvedOrderRequest } from '@platform/contracts';

export type RiskPolicy = { maxDailyLoss: string; maxWeeklyLoss: string; maxMonthlyLoss: string; maxDrawdownPercent: string; maxConcurrentPositions: number; maxExposure: string; maxLeverage: number; maxRiskPerTrade: string; maxPositionSize: string; consecutiveLossCooldown: number; tradingEnabled: boolean };
export type RiskContext = { equity: string; dailyPnl: string; weeklyPnl: string; monthlyPnl: string; peakEquity: string; exposure: string; openPositions: number; consecutiveLosses: number; markPrice: string; enforceMinimumNotional?: boolean };
export type RiskDecision = { approved: boolean; code: string; reasons: string[]; estimatedNotional: string; estimatedDrawdownPercent: string };
export function evaluateOrder(order: ResolvedOrderRequest, policy: RiskPolicy, context: RiskContext): RiskDecision {
  const reasons: string[] = [];
  const notional = new Decimal(order.quantity).mul(order.price ?? context.markPrice);
  const equity = new Decimal(context.equity);
  const drawdown = new Decimal(context.peakEquity).sub(equity);
  const drawdownPercent = new Decimal(context.peakEquity).isZero() ? new Decimal(0) : drawdown.div(context.peakEquity).mul(100);
  if (!policy.tradingEnabled) reasons.push('Trading is paused');
  if (new Decimal(context.dailyPnl).lessThan(new Decimal(policy.maxDailyLoss).neg())) reasons.push('Daily loss limit exceeded');
  if (new Decimal(context.weeklyPnl).lessThan(new Decimal(policy.maxWeeklyLoss).neg())) reasons.push('Weekly loss limit exceeded');
  if (new Decimal(context.monthlyPnl).lessThan(new Decimal(policy.maxMonthlyLoss).neg())) reasons.push('Monthly loss limit exceeded');
  if (drawdownPercent.greaterThan(policy.maxDrawdownPercent)) reasons.push('Maximum drawdown exceeded');
  if (context.openPositions >= policy.maxConcurrentPositions && !order.reduceOnly) reasons.push('Concurrent position limit exceeded');
  if (new Decimal(context.exposure).add(notional).greaterThan(policy.maxExposure) && !order.reduceOnly) reasons.push('Exposure limit exceeded');
  const minNotional = new Decimal(minOrderNotionalUsd(order.marketType));
  if ((context.enforceMinimumNotional !== false) && notional.lessThan(minNotional) && !order.reduceOnly) reasons.push(`Order value below minimum of $${minNotional.toFixed(0)} (${order.marketType})`);
  if ((order.leverage ?? 1) > policy.maxLeverage) reasons.push('Leverage limit exceeded');
  if (notional.greaterThan(policy.maxPositionSize) && !order.reduceOnly) reasons.push('Position size limit exceeded');
  if (!order.reduceOnly && order.stopPrice) { const riskPerTrade = new Decimal(order.price ?? context.markPrice).sub(order.stopPrice).abs().mul(order.quantity); if (riskPerTrade.greaterThan(policy.maxRiskPerTrade)) reasons.push('Risk per trade limit exceeded'); }
  if (context.consecutiveLosses >= policy.consecutiveLossCooldown && !order.reduceOnly) reasons.push('Consecutive-loss cooldown active');
  return { approved: reasons.length === 0, code: reasons.length === 0 ? 'APPROVED' : 'DENIED', reasons, estimatedNotional: notional.toFixed(), estimatedDrawdownPercent: drawdownPercent.toFixed(4) };
}
export function estimateLiquidationPrice(entryPrice: string, leverage: number, maintenanceMarginRate: string, side: 'LONG'|'SHORT'): string {
  const entry = new Decimal(entryPrice); const initialMarginRate = new Decimal(1).div(leverage); const maintenance = new Decimal(maintenanceMarginRate);
  return side === 'LONG' ? entry.mul(new Decimal(1).sub(initialMarginRate).add(maintenance)).toFixed() : entry.mul(new Decimal(1).add(initialMarginRate).sub(maintenance)).toFixed();
}
export class CircuitBreaker { private failures = 0; private openedAt: number | undefined; constructor(private readonly threshold: number, private readonly resetMs: number) {} canExecute(now = Date.now()): boolean { if (!this.openedAt) return true; if (now - this.openedAt >= this.resetMs) { this.failures = 0; this.openedAt = undefined; return true; } return false; } success(): void { this.failures = 0; this.openedAt = undefined; } failure(now = Date.now()): void { this.failures += 1; if (this.failures >= this.threshold) this.openedAt = now; } }
