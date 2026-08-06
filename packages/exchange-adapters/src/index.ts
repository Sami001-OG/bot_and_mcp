import ccxt, { type Exchange } from 'ccxt';
import type { ExchangeId, MarginMode, MarketType, OrderRequest } from '@platform/contracts';
import { ExchangeError, type AdapterCapabilities, type Balance, type ExchangeAdapter, type ExchangeConnection, type ExchangeCredentials, type ExchangeOrder, type Leverage, type Position } from '@platform/exchange-core';

const capabilities: Record<ExchangeId, AdapterCapabilities> = {
  binance: { marketTypes: ['SPOT','MARGIN','USDT_FUTURES','COIN_FUTURES'], hedgeMode: true, modifyOrder: false, batchOrders: true, trailingStop: true, openInterest: true, fundingRate: true },
  bybit: { marketTypes: ['SPOT','MARGIN','USDT_FUTURES','PERPETUAL'], hedgeMode: true, modifyOrder: true, batchOrders: true, trailingStop: true, openInterest: true, fundingRate: true },
  okx: { marketTypes: ['SPOT','MARGIN','USDT_FUTURES','COIN_FUTURES','PERPETUAL'], hedgeMode: true, modifyOrder: true, batchOrders: true, trailingStop: true, openInterest: true, fundingRate: true },
  kucoin: { marketTypes: ['SPOT','MARGIN','USDT_FUTURES'], hedgeMode: false, modifyOrder: false, batchOrders: true, trailingStop: true, openInterest: true, fundingRate: true },
  kraken: { marketTypes: ['SPOT','MARGIN'], hedgeMode: false, modifyOrder: true, batchOrders: false, trailingStop: true, openInterest: false, fundingRate: false },
  coinbase: { marketTypes: ['SPOT','PERPETUAL'], hedgeMode: false, modifyOrder: true, batchOrders: true, trailingStop: false, openInterest: false, fundingRate: true },
  mexc: { marketTypes: ['SPOT','USDT_FUTURES','PERPETUAL'], hedgeMode: true, modifyOrder: false, batchOrders: true, trailingStop: true, openInterest: true, fundingRate: true },
  hyperliquid: { marketTypes: ['SPOT','PERPETUAL'], hedgeMode: false, modifyOrder: true, batchOrders: true, trailingStop: false, openInterest: true, fundingRate: true }
};

const ccxtNames: Record<ExchangeId, keyof typeof ccxt> = {
  binance: 'binance', bybit: 'bybit', okx: 'okx', kucoin: 'kucoin', kraken: 'kraken', coinbase: 'coinbase', mexc: 'mexc', hyperliquid: 'hyperliquid'
};

export function mapExchangeStatus(status: string): ExchangeOrder['status'] {
  const map: Record<string, ExchangeOrder['status']> = { open: 'NEW', new: 'NEW', canceled: 'CANCELED', cancelled: 'CANCELED', rejected: 'REJECTED', expired: 'EXPIRED', 'partially-filled': 'PARTIALLY_FILLED', partially_filled: 'PARTIALLY_FILLED', closed: 'FILLED', filled: 'FILLED' };
  return map[status.toLowerCase()] ?? 'UNKNOWN';
}

export function resolveDefaultType(exchangeId: ExchangeId, marketType: MarketType): string {
  if (exchangeId === 'bybit') return marketType === 'SPOT' ? 'spot' : marketType === 'MARGIN' ? 'margin' : 'swap';
  if (marketType === 'SPOT') return 'spot';
  if (marketType === 'MARGIN') return 'margin';
  if (marketType === 'COIN_FUTURES') return 'delivery';
  if (marketType === 'PERPETUAL') return 'swap';
  return 'future';
}

export class CcxtExchangeAdapter implements ExchangeAdapter {
  readonly capabilities: AdapterCapabilities;
  private client?: Exchange;
  constructor(public readonly id: ExchangeId, private readonly marketType: MarketType) { this.capabilities = capabilities[id]; }

  async connect(credentials: ExchangeCredentials): Promise<ExchangeConnection> {
    const Constructor = ccxt[ccxtNames[this.id]] as unknown as new (config: Record<string, unknown>) => Exchange;
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    this.client = new Constructor({ apiKey: credentials.apiKey, secret: credentials.secret, password: credentials.passphrase, walletAddress: credentials.walletAddress, privateKey: credentials.privateKey, enableRateLimit: true, options: { defaultType: this.defaultType(), fetchOpenOrders: { warnWithoutSymbol: false } }, ...(proxy ? { httpsProxy: proxy } : {}) });
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.client.loadMarkets();
          const fetchedServerTime = this.client.has.fetchTime ? await this.client.fetchTime() : undefined;
          const serverTime = typeof fetchedServerTime === 'number' ? fetchedServerTime : Date.now();
          await this.client.fetchBalance();
          return { connected: true, serverTime: new Date(serverTime).toISOString(), permissions: ['read', 'trade'] };
        } catch (error) {
          lastError = error;
          if (!(error instanceof ccxt.NetworkError) && !(error instanceof ccxt.RequestTimeout)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      throw lastError;
    } catch (error) { throw this.normalize(error); }
  }
  async disconnect(): Promise<void> { if (this.client?.close) await this.client.close(); delete this.client; }
  async getBalance(): Promise<Balance[]> {
    try {
      const balance = await this.requireClient().fetchBalance();
      const free = balance.free as Record<string, number | undefined> | undefined;
      const used = balance.used as Record<string, number | undefined> | undefined;
      const total = balance.total as Record<string, number | undefined> | undefined;
      return Object.keys(total ?? {}).filter((asset) => Number(total?.[asset] ?? 0) !== 0).map((asset) => ({ asset, free: String(free?.[asset] ?? 0), locked: String(used?.[asset] ?? 0), total: String(total?.[asset] ?? 0) }));
    } catch (error) { throw this.normalize(error); }
  }
  async getPositions(): Promise<Position[]> {
    if (this.defaultType() === 'spot') return [];
    const client = this.requireClient();
    if (!client.has.fetchPositions) return [];
    try {
      const positions = await client.fetchPositions();
      return positions.filter((p) => Number(p.contracts ?? 0) !== 0).map((p) => ({
        symbol: String(p.symbol ?? ''),
        side: p.side === 'long' ? 'LONG' : p.side === 'short' ? 'SHORT' : 'BOTH',
        quantity: String(p.contracts ?? 0),
        entryPrice: String(p.entryPrice ?? 0),
        markPrice: String(p.markPrice ?? 0),
        unrealizedPnl: String(p.unrealizedPnl ?? 0),
        leverage: Number(p.leverage ?? 1),
        ...(p.liquidationPrice == null ? {} : { liquidationPrice: String(p.liquidationPrice) }),
        marginMode: p.marginMode === 'isolated' ? 'ISOLATED' : 'CROSS'
      }));
    } catch (error) { throw this.normalize(error); }
  }
  async getOrders(symbol?: string): Promise<ExchangeOrder[]> {
    try { return (await this.requireClient().fetchOpenOrders(symbol)).map((order) => this.mapOrder(order)); } catch (error) { throw this.normalize(error); }
  }
  async getOrder(orderId: string, symbol: string): Promise<ExchangeOrder> {
    try { return this.mapOrder(await this.requireClient().fetchOrder(orderId, symbol)); } catch (error) { throw this.normalize(error); }
  }
  async getPrice(symbol: string): Promise<string> {
    try {
      const ticker = await this.requireClient().fetchTicker(symbol);
      const price = ticker.last ?? ticker.average ?? ticker.ask ?? ticker.bid;
      if (price == null || Number(price) <= 0) throw new ExchangeError('PRICE_UNAVAILABLE', `No price available for ${symbol}`, false);
      return String(price);
    } catch (error) { throw this.normalize(error); }
  }
  async placeOrder(order: OrderRequest): Promise<ExchangeOrder> {
    const params: Record<string, unknown> = {};
    if (order.clientOrderId) params.clientOrderId = order.clientOrderId;
    if (order.reduceOnly) params.reduceOnly = true;
    if (order.postOnly) params.postOnly = true;
    if (order.timeInForce) params.timeInForce = order.timeInForce;
    if (order.positionSide === 'LONG' || order.positionSide === 'SHORT') params.positionSide = order.positionSide;
    if (order.stopPrice) params.stopPrice = order.stopPrice;
    if (order.callbackRate) params.callbackRate = order.callbackRate;
    try { return this.mapOrder(await this.requireClient().createOrder(order.symbol, this.mapType(order.type), order.side.toLowerCase(), Number(order.quantity), order.price ? Number(order.price) : undefined, params)); } catch (error) { throw this.normalize(error); }
  }
  async cancelOrder(orderId: string, symbol: string): Promise<ExchangeOrder> {
    try { return this.mapOrder(await this.requireClient().cancelOrder(orderId, symbol)); } catch (error) { throw this.normalize(error); }
  }
  async modifyOrder(orderId: string, order: OrderRequest): Promise<ExchangeOrder> {
    const client = this.requireClient();
    if (!client.has.editOrder) throw new ExchangeError('MODIFY_UNSUPPORTED', `${this.id} does not expose editOrder`, false);
    try { return this.mapOrder(await client.editOrder(orderId, order.symbol, this.mapType(order.type), order.side.toLowerCase(), Number(order.quantity), order.price ? Number(order.price) : undefined, { reduceOnly: order.reduceOnly })); } catch (error) { throw this.normalize(error); }
  }
  async getLeverage(symbol: string): Promise<Leverage> {
    const position = (await this.getPositions()).find((candidate) => candidate.symbol === symbol);
    return { symbol, leverage: position?.leverage ?? 1 };
  }
  async setLeverage(symbol: string, leverage: number): Promise<Leverage> {
    const client = this.requireClient();
    if (!client.has.setLeverage) throw new ExchangeError('LEVERAGE_UNSUPPORTED', `${this.id} does not expose setLeverage`, false);
    try { await client.setLeverage(leverage, symbol); return { symbol, leverage }; } catch (error) { throw this.normalize(error); }
  }
  async setMarginMode(symbol: string, mode: MarginMode): Promise<{ symbol: string; mode: MarginMode }> {
    const client = this.requireClient();
    if (!client.has.setMarginMode) throw new ExchangeError('MARGIN_MODE_UNSUPPORTED', `${this.id} does not expose setMarginMode`, false);
    try { await client.setMarginMode(mode.toLowerCase(), symbol); return { symbol, mode }; } catch (error) { throw this.normalize(error); }
  }
  private requireClient(): Exchange { if (!this.client) throw new ExchangeError('NOT_CONNECTED', `${this.id} adapter is disconnected`, false); return this.client; }
  private defaultType(): string { return resolveDefaultType(this.id, this.marketType); }
  private mapType(type: OrderRequest['type']): string { return ({ MARKET: 'market', LIMIT: 'limit', STOP: 'stop', STOP_MARKET: 'stop_market', STOP_LIMIT: 'stop_limit', TAKE_PROFIT: 'take_profit', TAKE_PROFIT_MARKET: 'take_profit_market', TRAILING_STOP: 'trailing_stop_market' } as const)[type]; }
  private mapOrder(order: { id?: unknown; clientOrderId?: unknown; symbol?: unknown; status?: unknown; side?: unknown; type?: unknown; amount?: unknown; filled?: unknown; average?: unknown; lastTradeTimestamp?: unknown; timestamp?: unknown }): ExchangeOrder { const updatedTimestamp = typeof order.lastTradeTimestamp === 'number' ? order.lastTradeTimestamp : typeof order.timestamp === 'number' ? order.timestamp : Date.now(); return { id: String(order.id), clientOrderId: String(order.clientOrderId ?? order.id), symbol: String(order.symbol), status: this.mapStatus(String(order.status ?? 'unknown')), side: String(order.side).toUpperCase() as 'BUY'|'SELL', type: String(order.type), quantity: String(order.amount ?? 0), filledQuantity: String(order.filled ?? 0), ...(order.average == null ? {} : { averagePrice: String(order.average) }), rawStatus: String(order.status ?? 'unknown'), updatedAt: new Date(updatedTimestamp).toISOString() }; }
  private mapStatus(status: string): ExchangeOrder['status'] { return mapExchangeStatus(status); }
  private normalize(error: unknown): ExchangeError { if (error instanceof ExchangeError) return error; const message = error instanceof Error ? error.message : 'Unknown exchange error'; const retryable = error instanceof ccxt.NetworkError || error instanceof ccxt.RateLimitExceeded; const ambiguous = error instanceof ccxt.RequestTimeout; return new ExchangeError(error instanceof Error ? error.name : 'EXCHANGE_ERROR', message, retryable, ambiguous); }
}

export function createExchangeAdapter(id: ExchangeId, marketType: MarketType): ExchangeAdapter {
  if (!capabilities[id]?.marketTypes.includes(marketType)) throw new ExchangeError('UNSUPPORTED_MARKET', `${id} does not support ${marketType}`, false);
  return new CcxtExchangeAdapter(id, marketType);
}
export { capabilities as exchangeCapabilities };
export { runReadOnlyCertification } from './certification.js';
export type { CertificationCheck, CertificationResult } from './certification.js';
