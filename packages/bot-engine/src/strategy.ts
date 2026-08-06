import { TradingViewSignalSchema, type MarketType, type OrderRequest, type PositionSide, type TradingViewSignal, type WebhookBotAction, type WebhookBotConfig } from '@platform/contracts';
import { sizeOrder } from '@platform/trading-core';
import type { StrategyContext, StrategyDecision, TradingStrategy } from './index.js';

export type SizedOrderRequest = {
  exchangeAccountId: string;
  exchange: string;
  marketType: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  quantity: string;
  price?: string;
  stopPrice?: string;
  reduceOnly: boolean;
  postOnly: boolean;
  clientOrderId: string;
  idempotencyKey: string;
  leverage?: number;
};

export type WebhookBuildInput = {
  signal: TradingViewSignal;
  config: WebhookBotConfig;
  account: { id: string; exchange: string; marketType: MarketType };
  price?: string;
  equity: string;
  maxEquity: string;
  currentPositionSide?: PositionSide;
};

export type WebhookBuildResult = { orders: SizedOrderRequest[]; notes: string[]; skipped: string[] };

const OPEN_SIDE: Record<'BUY' | 'LONG' | 'SELL' | 'SHORT', 'BUY' | 'SELL'> = { BUY: 'BUY', LONG: 'BUY', SELL: 'SELL', SHORT: 'SELL' };
const OPEN_POSITION: Record<'BUY' | 'LONG' | 'SELL' | 'SHORT', 'LONG' | 'SHORT'> = { BUY: 'LONG', LONG: 'LONG', SELL: 'SHORT', SHORT: 'SHORT' };
const CLOSE_POSITION: Record<'CLOSE_LONG' | 'CLOSE_SHORT', 'LONG' | 'SHORT'> = { CLOSE_LONG: 'LONG', CLOSE_SHORT: 'SHORT' };
const SIDE_OF_POSITION: Record<PositionSide, 'BUY' | 'SELL'> = { LONG: 'SELL', SHORT: 'BUY', BOTH: 'BUY' };

export function buildWebhookOrders(input: WebhookBuildInput): WebhookBuildResult {
  const { signal, config, account } = input;
  const orders: SizedOrderRequest[] = [];
  const notes: string[] = [];
  const skipped: string[] = [];
  const push = (order: SizedOrderRequest) => orders.push(order);

  const matchesSymbol = config.symbols.some((entry) => entry === '*' || entry.toUpperCase() === signal.symbol.toUpperCase());
  if (!matchesSymbol) { skipped.push(`Symbol ${signal.symbol} not in configured bot symbols`); return { orders, notes, skipped }; }
  if (config.actions && !config.actions.includes(signal.action as WebhookBotAction)) { skipped.push(`Action ${signal.action} not in configured bot actions`); return { orders, notes, skipped }; }
  if (signal.exchange.toLowerCase() !== account.exchange.toLowerCase()) { skipped.push(`Exchange ${signal.exchange} does not match bot account ${account.exchange}`); return { orders, notes, skipped }; }

  const suffix = signal.nonce.slice(-8);
  const base = { exchangeAccountId: account.id, exchange: account.exchange, marketType: account.marketType, symbol: signal.symbol, postOnly: false };

  const sizeEntry = (): { quantity: string; leverage?: number } | null => {
    if (!config.allocation) return signal.size ? { quantity: signal.size } : null;
    if (!input.price) { skipped.push('Allocation sizing skipped: market price unavailable'); return null; }
    const leverage = config.leverage ?? signal.leverage;
    const stopPrice = signal.stop_loss ?? config.stopLoss;
    const sized = sizeOrder({ allocation: config.allocation, marketType: account.marketType, price: input.price, equity: input.equity, maxEquity: input.maxEquity, ...(leverage === undefined ? {} : { leverage }), ...(stopPrice === undefined ? {} : { stopPrice }) });
    if (!sized.ok) { skipped.push(`Allocation sizing rejected: ${sized.reasons.join(', ')}`); return null; }
    return { quantity: sized.quantity as string, leverage: sized.leverage };
  };

  const buildEntryWithBracket = (side: 'BUY' | 'SELL', positionSide: 'LONG' | 'SHORT'): void => {
    const stopLoss = config.stopLoss ?? signal.stop_loss;
    if (config.requireSignalStopLoss && !stopLoss) { skipped.push('Stop loss required by bot config'); return; }
    const sized = sizeEntry();
    if (!sized) return;
    const entry: SizedOrderRequest = { ...base, side, positionSide, type: 'MARKET', quantity: sized.quantity, reduceOnly: false, clientOrderId: `wh-${suffix}`, idempotencyKey: `${signal.nonce}:entry`, ...(sized.leverage ? { leverage: sized.leverage } : {}) };
    push(entry);
    const closingSide: 'BUY' | 'SELL' = side === 'BUY' ? 'SELL' : 'BUY';
    if (stopLoss) push({ ...base, side: closingSide, positionSide, type: 'STOP_MARKET', quantity: sized.quantity, stopPrice: stopLoss, reduceOnly: true, clientOrderId: `wh-sl-${suffix}`, idempotencyKey: `${signal.nonce}:sl` });
    for (const [index, target] of (config.takeProfits ?? signal.take_profit ?? []).entries()) push({ ...base, side: closingSide, positionSide, type: 'TAKE_PROFIT_MARKET', quantity: sized.quantity, stopPrice: target, reduceOnly: true, clientOrderId: `wh-tp${index}-${suffix}`, idempotencyKey: `${signal.nonce}:tp:${index}` });
  };

  const close = (positionSide: 'LONG' | 'SHORT', quantity: string, kind: 'close' | 'partial'): void => {
    push({ ...base, side: SIDE_OF_POSITION[positionSide], positionSide, type: 'MARKET', quantity, reduceOnly: true, clientOrderId: `wh-${kind === 'partial' ? 'px' : 'cx'}-${suffix}`, idempotencyKey: `${signal.nonce}:${kind}` });
  };

  switch (signal.action) {
    case 'BUY': case 'LONG': case 'SELL': case 'SHORT':
      buildEntryWithBracket(OPEN_SIDE[signal.action], OPEN_POSITION[signal.action]);
      break;
    case 'CLOSE_LONG': case 'CLOSE_SHORT':
      close(CLOSE_POSITION[signal.action], signal.size, 'close');
      break;
    case 'PARTIAL_EXIT': {
      if (!input.currentPositionSide || input.currentPositionSide === 'BOTH') { skipped.push('PARTIAL_EXIT requires position state'); break; }
      const quantity = (Number(signal.size) * (signal.close_percentage ?? 100) / 100).toFixed(8);
      close(input.currentPositionSide, quantity, 'partial');
      break;
    }
    case 'REVERSE': {
      if (!input.currentPositionSide || input.currentPositionSide === 'BOTH') { skipped.push('REVERSE requires position state'); break; }
      close(input.currentPositionSide, signal.size, 'close');
      buildEntryWithBracket(SIDE_OF_POSITION[input.currentPositionSide], input.currentPositionSide === 'LONG' ? 'SHORT' : 'LONG');
      break;
    }
    default:
      skipped.push(`Action ${signal.action} is not supported by webhook bots`);
  }
  return { orders, notes, skipped };
}

export class WebhookSignalStrategy implements TradingStrategy {
  readonly type = 'WEBHOOK' as const;
  constructor(private readonly config: WebhookBotConfig) {}
  async evaluate(context: StrategyContext): Promise<StrategyDecision> {
    const raw = context.tick.indicators['signal'];
    if (!raw) return { orders: [], state: { ...context.state }, logs: ['No signal payload in tick indicators'] };
    try {
      const signal = TradingViewSignalSchema.parse(JSON.parse(raw));
      const account = { id: context.exchangeAccountId, exchange: context.tick.symbol.split('/')[1]?.toLowerCase() ?? 'bybit', marketType: 'USDT_FUTURES' as MarketType };
      const result = buildWebhookOrders({ signal, config: this.config, account, price: context.tick.price, equity: '0', maxEquity: '0' });
      return { orders: result.orders.map((order) => ({ ...order, exchange: order.exchange as OrderRequest['exchange'], marketType: order.marketType as OrderRequest['marketType'], positionSide: order.positionSide as OrderRequest['positionSide'], type: order.type as OrderRequest['type'], timeInForce: 'GTC' as const, clientOrderId: `${order.clientOrderId}-${context.botId.slice(0, 8)}`, idempotencyKey: `${order.idempotencyKey}:${context.botId.slice(0, 8)}` })), state: { ...context.state, lastSignal: signal.nonce }, logs: [...result.notes, ...result.skipped] };
    } catch {
      return { orders: [], state: { ...context.state }, logs: ['Signal payload failed validation'] };
    }
  }
}
