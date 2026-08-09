import { z } from 'zod';

export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'Expected a decimal string');
export const PositiveDecimalString = DecimalString.refine((value) => Number(value) > 0);
export const ExchangeId = z.enum(['binance', 'bybit', 'okx', 'kucoin', 'kraken', 'coinbase', 'mexc', 'hyperliquid']);
export type ExchangeId = z.infer<typeof ExchangeId>;
export const MarketType = z.enum(['SPOT', 'MARGIN', 'USDT_FUTURES', 'COIN_FUTURES', 'PERPETUAL']);
export type MarketType = z.infer<typeof MarketType>;
export const OrderSide = z.enum(['BUY', 'SELL']);
export type OrderSide = z.infer<typeof OrderSide>;
export const PositionSide = z.enum(['LONG', 'SHORT', 'BOTH']);
export type PositionSide = z.infer<typeof PositionSide>;
export const OrderType = z.enum([
  'MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET', 'TRAILING_STOP'
]);
export type OrderType = z.infer<typeof OrderType>;
export const TimeInForce = z.enum(['GTC', 'IOC', 'FOK']);
export type TimeInForce = z.infer<typeof TimeInForce>;
export const MarginMode = z.enum(['CROSS', 'ISOLATED']);
export type MarginMode = z.infer<typeof MarginMode>;

export const MIN_ORDER_NOTIONAL_USD: Record<MarketType, string> = {
  SPOT: '5',
  MARGIN: '5',
  USDT_FUTURES: '10',
  COIN_FUTURES: '10',
  PERPETUAL: '10'
};
export function minOrderNotionalUsd(marketType: MarketType): string {
  return MIN_ORDER_NOTIONAL_USD[marketType];
}

export const AllocationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('PERCENT_EQUITY'), percent: z.number().positive().max(100) }),
  z.object({ mode: z.literal('PERCENT_MAX_EQUITY'), percent: z.number().positive().max(100) }),
  z.object({ mode: z.literal('FIXED_AMOUNT'), amount: DecimalString.refine((value) => Number(value) > 0) }),
  z.object({ mode: z.literal('RISK_PERCENT'), percent: z.number().positive().max(100) })
]);
export type Allocation = z.infer<typeof AllocationSchema>;

export const OrderRequestSchema = z.object({
  exchangeAccountId: z.string().min(1),
  exchange: ExchangeId,
  marketType: MarketType,
  symbol: z.string().min(3).max(40).transform((value) => value.toUpperCase()),
  side: OrderSide,
  positionSide: PositionSide.default('BOTH'),
  type: OrderType,
  quantity: PositiveDecimalString.optional(),
  allocation: AllocationSchema.optional(),
  price: PositiveDecimalString.optional(),
  stopPrice: PositiveDecimalString.optional(),
  callbackRate: PositiveDecimalString.optional(),
  reduceOnly: z.boolean().default(false),
  postOnly: z.boolean().default(false),
  timeInForce: TimeInForce.default('GTC'),
  leverage: z.number().int().min(1).max(200).optional(),
  marginMode: MarginMode.optional(),
  clientOrderId: z.string().min(8).max(64),
  idempotencyKey: z.string().min(16).max(128)
}).superRefine((value, ctx) => {
  if ((!value.quantity && !value.allocation) || (value.quantity && value.allocation)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: 'Provide exactly one of quantity or allocation' });
  }
  if (['LIMIT', 'STOP_LIMIT', 'TAKE_PROFIT'].includes(value.type) && !value.price) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'Price is required' });
  }
  if (['STOP', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'].includes(value.type) && !value.stopPrice) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopPrice'], message: 'Stop price is required' });
  }
});
export type OrderRequest = z.infer<typeof OrderRequestSchema>;
export type ResolvedOrderRequest = Omit<OrderRequest, 'quantity'> & { quantity: string };

export const TradingViewSignalSchema = z.object({
  exchange: ExchangeId,
  symbol: z.string().min(3).max(40).transform((value) => value.toUpperCase()),
  action: z.enum(['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'REVERSE', 'SET_LEVERAGE', 'MOVE_STOP', 'PARTIAL_EXIT']),
  size: PositiveDecimalString,
  leverage: z.number().int().min(1).max(200).optional(),
  stop_loss: PositiveDecimalString.optional(),
  take_profit: z.array(PositiveDecimalString).max(20).optional(),
  reduce_only: z.boolean().default(false),
  close_percentage: z.number().positive().max(100).optional(),
  nonce: z.string().min(12).max(128),
  timestamp: z.string().datetime()
});
export type TradingViewSignal = z.infer<typeof TradingViewSignalSchema>;

export const WebhookBotConfigSchema = z.object({
  symbols: z.array(z.string().min(3).max(40)).min(1),
  allocation: AllocationSchema.optional(),
  leverage: z.number().int().min(1).max(200).optional(),
  stopLoss: PositiveDecimalString.optional(),
  takeProfits: z.array(PositiveDecimalString).max(20).optional(),
  requireSignalStopLoss: z.boolean().default(false),
  actions: z.array(z.enum(['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'REVERSE', 'PARTIAL_EXIT'])).optional()
});
export type WebhookBotConfig = z.infer<typeof WebhookBotConfigSchema>;
export type WebhookBotAction = WebhookBotConfig['actions'] extends Array<infer T> | undefined ? T : never;

export const WorkspaceHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?!.*--)[a-z0-9-]{1,30}[a-z0-9]$/, 'Handle must be 3-32 characters: lowercase letters, digits and hyphens (no consecutive, leading or trailing hyphens)');
export type WorkspaceHandle = z.infer<typeof WorkspaceHandleSchema>;

export function workspaceHandleFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const slug = local
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) return slug;
  const fallback = slug.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  return `${fallback}-${Math.random().toString(36).slice(2, 8)}`;
}

export type ApiProblem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  correlationId: string;
  errors?: Record<string, string[]>;
};

export type RealtimeEnvelope<T> = {
  version: 1;
  topic: string;
  sequence: string;
  timestamp: string;
  correlationId: string;
  data: T;
};
