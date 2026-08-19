import type { ExchangeId, MarginMode, MarketType, OrderRequest, PositionSide } from '@platform/contracts';

export type ExchangeCredentials = { apiKey: string; secret: string; passphrase?: string; walletAddress?: string; privateKey?: string; testnet?: boolean };
export type ExchangeConnection = { connected: boolean; serverTime: string; permissions: string[]; accountMode?: string };
export type Balance = { asset: string; free: string; locked: string; total: string; usdValue?: string };
export type Position = { symbol: string; side: PositionSide; quantity: string; entryPrice: string; markPrice: string; unrealizedPnl: string; leverage: number; liquidationPrice?: string; marginMode: MarginMode };
export type ExchangeFee = { cost: string; asset: string };
export type MarketInfo = { symbol: string; base: string; quote: string; type: 'spot'|'swap'|'future'|'margin'|'delivery'|'option'|'perpetual'; active: boolean; amountStep?: number; amountMin?: number; priceStep?: number; priceMin?: number };
export type MarketPrecision = { amountStep?: number; amountMin?: number; priceStep?: number; priceMin?: number };
export type ExchangeOrder = { id: string; clientOrderId: string; symbol: string; status: 'NEW'|'PARTIALLY_FILLED'|'FILLED'|'CANCELED'|'REJECTED'|'EXPIRED'|'UNKNOWN'; side: 'BUY'|'SELL'; type: string; quantity: string; filledQuantity: string; averagePrice?: string; fee?: ExchangeFee; rawStatus: string; updatedAt: string };
export type Leverage = { symbol: string; leverage: number };
export type OHLCV = { timestamp: string; open: string; high: string; low: string; close: string; volume: string };
export type FundingRate = { symbol: string; fundingRate: string; nextFundingTime?: string };
export type OpenInterest = { symbol: string; openInterest: string };
export type AdapterCapabilities = {
  marketTypes: MarketType[];
  hedgeMode: boolean;
  modifyOrder: boolean;
  batchOrders: boolean;
  trailingStop: boolean;
  openInterest: boolean;
  fundingRate: boolean;
};

export class ExchangeError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean, public readonly ambiguous = false) { super(message); }
}

export interface ExchangeAdapter {
  readonly id: ExchangeId;
  readonly capabilities: AdapterCapabilities;
  connect(credentials: ExchangeCredentials): Promise<ExchangeConnection>;
  disconnect(): Promise<void>;
  getBalance(): Promise<Balance[]>;
  getPositions(): Promise<Position[]>;
  getMarkets(): Promise<MarketInfo[]>;
  getOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getOrder(orderId: string, symbol: string): Promise<ExchangeOrder>;
  findOrderByClientOrderId(clientOrderId: string, symbol: string): Promise<ExchangeOrder | null>;
  getPrice(symbol: string): Promise<string>;
  placeOrder(order: OrderRequest): Promise<ExchangeOrder>;
  cancelOrder(orderId: string, symbol: string): Promise<ExchangeOrder>;
  modifyOrder(orderId: string, order: OrderRequest): Promise<ExchangeOrder>;
  getLeverage(symbol: string): Promise<Leverage>;
  setLeverage(symbol: string, leverage: number): Promise<Leverage>;
  setMarginMode(symbol: string, mode: MarginMode): Promise<{ symbol: string; mode: MarginMode }>;
  getOHLCV(symbol: string, timeframe?: string, limit?: number): Promise<OHLCV[]>;
  getFundingRate(symbol: string): Promise<FundingRate | null>;
  getOpenInterest(symbol: string): Promise<OpenInterest | null>;
}

export function assertCapability(adapter: ExchangeAdapter, marketType: MarketType): void {
  if (!adapter.capabilities.marketTypes.includes(marketType)) {
    throw new ExchangeError('UNSUPPORTED_MARKET', `${adapter.id} does not support ${marketType}`, false);
  }
}
