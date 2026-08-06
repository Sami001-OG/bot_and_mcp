import type { OrderRequest } from '@platform/contracts';
export type BotType = 'WEBHOOK'|'INDICATOR'|'DCA'|'GRID'|'SCALPING'|'TREND'|'BREAKOUT'|'MEAN_REVERSION'|'ARBITRAGE'|'CUSTOM';
export type BotStatus = 'DRAFT'|'ACTIVE'|'PAUSED'|'STOPPED'|'ERROR';
export type MarketTick = { symbol: string; price: string; timestamp: string; indicators: Record<string, string> };
export type StrategyContext = { botId: string; workspaceId: string; exchangeAccountId: string; tick: MarketTick; state: Readonly<Record<string, unknown>> };
export type StrategyDecision = { orders: OrderRequest[]; state: Record<string, unknown>; logs: string[] };
export interface TradingStrategy { readonly type: BotType; evaluate(context: StrategyContext): Promise<StrategyDecision>; }
export class BotRuntime {
  constructor(private readonly strategy: TradingStrategy, private status: BotStatus = 'DRAFT') {}
  activate(): void { if (!['DRAFT','PAUSED','STOPPED'].includes(this.status)) throw new Error(`Cannot activate bot from ${this.status}`); this.status = 'ACTIVE'; }
  pause(): void { if (this.status !== 'ACTIVE') throw new Error(`Cannot pause bot from ${this.status}`); this.status = 'PAUSED'; }
  stop(): void { this.status = 'STOPPED'; }
  getStatus(): BotStatus { return this.status; }
  async onTick(context: StrategyContext): Promise<StrategyDecision> { if (this.status !== 'ACTIVE') return { orders: [], state: { ...context.state }, logs: [`Bot ignored tick while ${this.status}`] }; return this.strategy.evaluate(context); }
}
export { buildWebhookOrders, WebhookSignalStrategy, type SizedOrderRequest, type WebhookBuildInput, type WebhookBuildResult } from './strategy.js';
