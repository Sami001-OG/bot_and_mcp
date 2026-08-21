import ccxt, { type Exchange } from 'ccxt';
import type { ExchangeId, MarginMode, MarketType, OrderRequest } from '@platform/contracts';
import { ExchangeError, type AdapterCapabilities, type Balance, type ExchangeAdapter, type ExchangeConnection, type ExchangeConnectOptions, type ExchangeCredentials, type ExchangeOrder, type FundingRate, type Leverage, type MarketInfo, type OHLCV, type OpenInterest, type Position } from '@platform/exchange-core';

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

const positionModeCache = new Map<string, { mode: 'one-way' | 'hedged'; at: number }>();
const POSITION_MODE_TTL_MS = 5 * 60 * 1000;
function positionModeKey(testnet: boolean | undefined, apiKey: string | undefined): string { return `${testnet ? 'testnet' : 'mainnet'}:${apiKey ?? ''}`; }
function isPositionIdxMismatch(error: unknown): boolean { return error instanceof Error && /position idx/i.test(error.message); }

export function matchOrderByClientOrderId(orders: ExchangeOrder[], clientOrderId: string): ExchangeOrder | null {
  const target = clientOrderId.trim().toLowerCase();
  return orders.find((order) => order.clientOrderId.trim().toLowerCase() === target || order.id.trim().toLowerCase() === target) ?? null;
}

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

type CcxtMarketLike = { symbol: string; type?: unknown; base?: unknown; quote?: unknown; active?: unknown };

export function resolveMarketSymbol(markets: Record<string, CcxtMarketLike>, symbol: string, expectedType: string, spotType = 'spot'): string {
  const exact = markets[symbol];
  if (exact && (String(exact.type).toLowerCase() === expectedType || expectedType === spotType)) return symbol;
  const base = symbol.split('/')[0]?.toUpperCase();
  const quote = symbol.split('/')[1]?.split(':')[0]?.toUpperCase();
  if (!base || !quote) return symbol;
  const candidates = Object.values(markets).filter((market) => String(market.base).toUpperCase() === base && String(market.quote).toUpperCase() === quote && market.active !== false);
  const match = candidates.find((market) => String(market.type).toLowerCase() === expectedType) ?? (exact ? exact : undefined) ?? candidates[0];
  return match ? String(match.symbol) : symbol;
}

export function bareSymbol(symbol: string): string { return symbol.split(':')[0] ?? ''; }

export function buildCcxtMarkets(infos: MarketInfo[]): Record<string, unknown> {
  const markets: Record<string, unknown> = {};
  for (const m of infos) {
    const contract = m.type === 'swap' || m.type === 'future' || m.type === 'delivery' || m.type === 'perpetual' || m.type === 'option';
    const spot = m.type === 'spot' || m.type === 'margin';
    const settle = contract ? (m.settle ?? (m.linear === false ? m.base : m.quote)) : undefined;
    const linear = contract ? (m.linear ?? !(settle === m.base)) : false;
    const precision: Record<string, number> = {};
    if (m.amountStep != null && Number.isFinite(m.amountStep) && m.amountStep > 0) precision.amount = m.amountStep;
    if (m.priceStep != null && Number.isFinite(m.priceStep) && m.priceStep > 0) precision.price = m.priceStep;
    const limits: Record<string, { min?: number }> = {};
    if (m.amountMin != null && Number.isFinite(m.amountMin) && m.amountMin > 0) limits.amount = { min: m.amountMin };
    if (m.priceMin != null && Number.isFinite(m.priceMin) && m.priceMin > 0) limits.price = { min: m.priceMin };
    markets[m.symbol] = {
      id: m.id,
      symbol: m.symbol,
      base: m.base,
      quote: m.quote,
      ...(settle !== undefined ? { settle } : {}),
      baseId: m.base,
      quoteId: m.quote,
      type: m.type,
      spot,
      contract,
      linear,
      inverse: contract && !linear,
      active: m.active !== false,
      precision,
      limits,
    };
  }
  return markets;
}

export class CcxtExchangeAdapter implements ExchangeAdapter {
  readonly capabilities: AdapterCapabilities;
  private client?: Exchange;
  private credentialsKey?: string;
  constructor(public readonly id: ExchangeId, private readonly marketType: MarketType) { this.capabilities = capabilities[id]; }

  async connect(credentials: ExchangeCredentials, options?: ExchangeConnectOptions): Promise<ExchangeConnection> {
    const Constructor = ccxt[ccxtNames[this.id]] as unknown as new (config: Record<string, unknown>) => Exchange;
    this.credentialsKey = positionModeKey(credentials.testnet, credentials.apiKey);
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const config: Record<string, unknown> = { apiKey: credentials.apiKey, secret: credentials.secret, password: credentials.passphrase, walletAddress: credentials.walletAddress, privateKey: credentials.privateKey, enableRateLimit: true, options: { defaultType: this.defaultType(), fetchOpenOrders: { warnWithoutSymbol: false }, ...(this.id === 'bybit' ? { recvWindow: 60000, adjustForTimeDifference: true } : {}) } };
    if (proxy) config.httpsProxy = proxy;
    if (options?.markets?.length) config.markets = buildCcxtMarkets(options.markets);
    this.client = new Constructor(config);
    if (credentials.testnet) this.client.setSandboxMode(true);
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.client.loadMarkets();
          if (this.id === 'bybit') await this.client.loadTimeDifference();
          const timeDifference = this.client.options?.timeDifference;
          const serverTime = typeof timeDifference === 'number' ? Date.now() + timeDifference : Date.now();
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
        symbol: this.bareSymbol(String(p.symbol ?? '')),
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
  async getMarkets(reload = false): Promise<MarketInfo[]> {
    const client = this.requireClient();
    if (!client.has.fetchMarkets) return [];
    try {
      const loaded = reload ? await client.loadMarkets(true) : await client.fetchMarkets();
      const markets = Array.isArray(loaded) ? loaded : Object.values(loaded);
      const result: MarketInfo[] = [];
      for (const market of markets) {
        if (!market || market.active === false) continue;
        if (!market.base || !market.quote) continue;
        const precision = (market.precision as { amount?: number | string; price?: number | string } | undefined) ?? {};
        const amountStep = precision.amount === undefined ? undefined : Number(precision.amount);
        const priceStep = precision.price === undefined ? undefined : Number(precision.price);
        const amountMin = (market.limits as { amount?: { min?: number | string } } | undefined)?.amount?.min;
        const priceMin = (market.limits as { price?: { min?: number | string } } | undefined)?.price?.min;
        result.push({
          symbol: String(market.symbol ?? ''), id: String(market.id ?? market.symbol ?? ''), base: String(market.base ?? ''), quote: String(market.quote ?? ''), type: String(market.type).toLowerCase() as MarketInfo['type'], active: true,
          ...(market.linear !== undefined ? { linear: Boolean(market.linear) } : {}),
          ...(market.settle != null ? { settle: String(market.settle) } : {}),
          ...(amountStep !== undefined && Number.isFinite(amountStep) && amountStep > 0 ? { amountStep } : {}),
          ...(priceStep !== undefined && Number.isFinite(priceStep) && priceStep > 0 ? { priceStep } : {}),
          ...(amountMin !== undefined && Number.isFinite(Number(amountMin)) && Number(amountMin) > 0 ? { amountMin: Number(amountMin) } : {}),
          ...(priceMin !== undefined && Number.isFinite(Number(priceMin)) && Number(priceMin) > 0 ? { priceMin: Number(priceMin) } : {})
        });
      }
      return result;
    } catch (error) { throw this.normalize(error); }
  }
  async getOrders(symbol?: string): Promise<ExchangeOrder[]> {
    try {
      const client = this.requireClient();
      const resolved = symbol === undefined ? undefined : this.marketSymbol(symbol);
      const orders = resolved === undefined ? await client.fetchOpenOrders() : await client.fetchOpenOrders(resolved);
      return orders.map((order) => this.mapOrder(order));
    } catch (error) { throw this.normalize(error); }
  }
  async getOrder(orderId: string, symbol: string): Promise<ExchangeOrder> {
    try {
      const client = this.requireClient();
      const params = this.id === 'bybit' ? { acknowledged: true } : {};
      return this.mapOrder(await client.fetchOrder(orderId, this.marketSymbol(symbol), params));
    } catch (error) { throw this.normalize(error); }
  }
  async findOrderByClientOrderId(clientOrderId: string, symbol: string): Promise<ExchangeOrder | null> {
    const client = this.requireClient();
    const resolved = this.marketSymbol(symbol);
    try {
      const open = await client.fetchOpenOrders(resolved);
      const found = matchOrderByClientOrderId(open.map((order) => this.mapOrder(order)), clientOrderId);
      if (found) return found;
      if (!client.has.fetchClosedOrders) return null;
      const closed = await client.fetchClosedOrders(resolved, Date.now() - 10 * 60 * 1000);
      return matchOrderByClientOrderId(closed.map((order) => this.mapOrder(order)), clientOrderId);
    } catch (error) { throw this.normalize(error); }
  }
  async getPrice(symbol: string): Promise<string> {
    try {
      const ticker = await this.requireClient().fetchTicker(this.marketSymbol(symbol));
      const price = ticker.last ?? ticker.average ?? ticker.ask ?? ticker.bid;
      if (price == null || Number(price) <= 0) throw new ExchangeError('PRICE_UNAVAILABLE', `No price available for ${symbol}`, false);
      return String(price);
    } catch (error) { throw this.normalize(error); }
  }
  async placeOrder(order: OrderRequest): Promise<ExchangeOrder> {
    const params: Record<string, unknown> = {};
    if (order.clientOrderId) params.clientOrderId = order.clientOrderId;
    if (order.reduceOnly && this.marketType !== 'SPOT') params.reduceOnly = true;
    if (order.postOnly) params.postOnly = true;
    if (order.timeInForce) params.timeInForce = order.timeInForce;
    if (this.id === 'bybit' && this.marketType !== 'SPOT') {
      await this.applyBybitPositionMode(order, params);
    } else if (order.positionSide === 'LONG' || order.positionSide === 'SHORT') {
      params.positionSide = order.positionSide;
    }
    const effective = this.marketType === 'SPOT' && order.side.toUpperCase() === 'SELL' ? { ...order, quantity: await this.clampSpotSellQuantity(order) } : order;
    try { return await this.executePlacement(effective, params); }
    catch (error) {
      if (this.id === 'bybit' && isPositionIdxMismatch(error) && this.credentialsKey) {
        positionModeCache.delete(this.credentialsKey);
        delete params.positionIdx;
        delete params.hedged;
        await this.applyBybitPositionMode(effective, params);
        try { return await this.executePlacement(effective, params); }
        catch (error2) { throw this.normalize(error2); }
      }
      throw this.normalize(error);
    }
  }
  private async clampSpotSellQuantity(order: OrderRequest): Promise<string> {
    const client = this.requireClient();
    const resolved = this.marketSymbol(order.symbol);
    const market = (client.markets ?? {})[resolved] as { base?: unknown } | undefined;
    const base = String(market?.base ?? order.symbol.split('/')[0] ?? '').toUpperCase();
    const requested = Number(order.quantity);
    if (!base || !Number.isFinite(requested) || requested <= 0) return order.quantity ?? String(requested);
    let free = 0;
    try {
      const balance = await client.fetchBalance();
      free = Number((balance as unknown as Record<string, { free?: number } | undefined>)[base]?.free ?? 0);
    } catch (error) { throw this.normalize(error); }
    if (!(free > 0)) throw new ExchangeError('INSUFFICIENT_FUNDS', `No free ${base} balance to sell ${order.symbol}`, false);
    if (requested <= free) return order.quantity ?? String(requested);
    const aligned = Number(client.amountToPrecision(resolved, free));
    if (!(aligned > 0)) throw new ExchangeError('INSUFFICIENT_FUNDS', `Free ${base} balance rounds to zero at the amount step for ${order.symbol}`, false);
    return String(aligned);
  }
  private async executePlacement(order: OrderRequest, params: Record<string, unknown>): Promise<ExchangeOrder> {
    if (order.type === 'TRAILING_STOP') {
      if (this.id === 'bybit' && this.marketType !== 'SPOT') {
        const client = this.requireClient() as unknown as { privatePostV5PositionTradingStop: (request: Record<string, unknown>) => Promise<{ result?: { stopOrderId?: string; orderId?: string } }> };
        const [base, quot] = order.symbol.split('/');
        const exchangeSymbol = `${base?.toUpperCase()}${quot?.split(':')[0]?.toUpperCase()}`;
        const positionSide = order.positionSide ?? (order.side.toLowerCase() === 'buy' ? 'LONG' : 'SHORT');
        const hedgedMode = (await this.bybitPositionMode(order.symbol)) === 'hedged';
        const request: Record<string, unknown> = {
          category: 'linear',
          symbol: exchangeSymbol,
          trailingStop: order.callbackRate ?? '1',
          ...(order.stopPrice ? { activePrice: String(order.stopPrice) } : {}),
          ...(hedgedMode ? { positionIdx: positionSide === 'SHORT' ? 2 : 1 } : {})
        };
        const response = await client.privatePostV5PositionTradingStop(request);
        const result = response.result ?? {};
        const id = String(result.stopOrderId ?? result.orderId ?? '');
        const created: ExchangeOrder = {
          id,
          clientOrderId: order.clientOrderId ?? '',
          symbol: order.symbol,
          side: order.side.toLowerCase() as ExchangeOrder['side'],
          type: order.type,
          status: id ? 'NEW' : 'REJECTED',
          quantity: String(order.quantity),
          filledQuantity: '0',
          rawStatus: id ? 'open' : 'rejected',
          updatedAt: new Date().toISOString()
        };
        if (!id) throw new Error(`Bybit trailing stop rejected: ${JSON.stringify(response)}`);
        return created;
      }
      if (this.marketType === 'SPOT') throw new Error('Trailing stops are not supported on spot orders');
    }
    if (order.stopPrice) {
      if (this.id === 'bybit' && this.marketType !== 'SPOT') {
        const client = this.requireClient() as unknown as { privatePostV5OrderCreate: (request: Record<string, unknown>) => Promise<{ result?: { orderId?: string; orderLinkId?: string } }> };
        const [base, quot] = order.symbol.split('/');
        const exchangeSymbol = `${base?.toUpperCase()}${quot?.split(':')[0]?.toUpperCase()}`;
        const reduceOnly = order.reduceOnly;
        const positionSide = order.positionSide ?? (order.side.toLowerCase() === 'buy' ? 'LONG' : 'SHORT');
        const isTakeProfit = order.type === 'TAKE_PROFIT' || order.type === 'TAKE_PROFIT_MARKET';
        const triggerDirection = order.side.toLowerCase() === 'buy' ? (isTakeProfit ? 2 : 1) : (isTakeProfit ? 1 : 2);
        const hedgedMode = (await this.bybitPositionMode(order.symbol)) === 'hedged';
        const triggerRequest: Record<string, unknown> = {
          category: 'linear',
          symbol: exchangeSymbol,
          side: order.side.toLowerCase() === 'buy' ? 'Buy' : 'Sell',
          orderType: order.type === 'TRAILING_STOP' ? 'TrailingStop' : 'Market',
          qty: String(order.quantity),
          timeInForce: order.postOnly ? 'PostOnly' : 'GTC',
          reduceOnly,
          triggerPrice: String(order.stopPrice),
          triggerDirection,
          triggerBy: 'LastPrice',
          ...(order.type === 'TRAILING_STOP' && order.callbackRate ? { callbackRate: order.callbackRate } : {}),
          ...(hedgedMode ? { positionIdx: positionSide === 'SHORT' ? 2 : 1 } : {}),
          ...(order.clientOrderId ? { orderLinkId: order.clientOrderId } : {})
        };
        const response = await client.privatePostV5OrderCreate(triggerRequest);
        const result = response.result ?? {};
        const created: ExchangeOrder = {
          id: String(result.orderId ?? ''),
          clientOrderId: order.clientOrderId ?? '',
          symbol: order.symbol,
          side: order.side.toLowerCase() as ExchangeOrder['side'],
          type: order.type,
          status: result.orderId ? 'NEW' : 'REJECTED',
          quantity: String(order.quantity),
          filledQuantity: '0',
          rawStatus: result.orderId ? 'open' : 'rejected',
          updatedAt: new Date().toISOString()
        };
        if (!result.orderId) throw new Error(`Bybit conditional order rejected: ${JSON.stringify(response)}`);
        return created;
      }
      params.triggerPrice = order.stopPrice;
      if (this.id === 'bybit' && this.marketType !== 'SPOT') params.triggerDirection = order.side.toLowerCase() === 'buy' ? 'ascending' : 'descending';
    }
    if (order.callbackRate) params.callbackRate = order.callbackRate;
    return this.mapOrder(await this.requireClient().createOrder(this.marketSymbol(order.symbol), this.createOrderType(order.type), order.side.toLowerCase(), Number(order.quantity), order.price ? Number(order.price) : undefined, params));
  }
  private async applyBybitPositionMode(order: OrderRequest, params: Record<string, unknown>): Promise<void> {
    if ((await this.bybitPositionMode(order.symbol)) !== 'hedged') return;
    if (order.positionSide === 'LONG' || order.positionSide === 'SHORT') {
      params.positionIdx = order.positionSide === 'LONG' ? 1 : 2;
      params.hedged = true;
    } else if (order.reduceOnly) {
      params.positionIdx = order.side.toLowerCase() === 'sell' ? 1 : 2;
    }
  }
  private async bybitPositionMode(symbol: string): Promise<'one-way' | 'hedged'> {
    if (this.id !== 'bybit' || this.marketType === 'SPOT' || !this.credentialsKey) return 'one-way';
    const cached = positionModeCache.get(this.credentialsKey);
    if (cached && Date.now() - cached.at < POSITION_MODE_TTL_MS) return cached.mode;
    let mode: 'one-way' | 'hedged' = 'one-way';
    try {
      const positions = await this.requireClient().fetchPositions([this.marketSymbol(symbol)]);
      const indexes = positions.map((p) => Number((p.info as { positionIdx?: number } | undefined)?.positionIdx ?? 0));
      if (indexes.some((idx) => idx === 1 || idx === 2)) mode = 'hedged';
    } catch { mode = 'one-way'; }
    positionModeCache.set(this.credentialsKey, { mode, at: Date.now() });
    return mode;
  }
  async cancelOrder(orderId: string, symbol: string): Promise<ExchangeOrder> {
    try { return this.mapOrder(await this.requireClient().cancelOrder(orderId, this.marketSymbol(symbol))); } catch (error) { throw this.normalize(error); }
  }
  async modifyOrder(orderId: string, order: OrderRequest): Promise<ExchangeOrder> {
    const client = this.requireClient();
    if (!client.has.editOrder) throw new ExchangeError('MODIFY_UNSUPPORTED', `${this.id} does not expose editOrder`, false);
    try { return this.mapOrder(await client.editOrder(orderId, this.marketSymbol(order.symbol), this.mapType(order.type), order.side.toLowerCase(), Number(order.quantity), order.price ? Number(order.price) : undefined, { reduceOnly: order.reduceOnly })); } catch (error) { throw this.normalize(error); }
  }
  async getLeverage(symbol: string): Promise<Leverage> {
    const position = (await this.getPositions()).find((candidate) => candidate.symbol.toUpperCase() === symbol.toUpperCase());
    return { symbol, leverage: position?.leverage ?? 1 };
  }
  async setLeverage(symbol: string, leverage: number): Promise<Leverage> {
    const client = this.requireClient();
    if (!client.has.setLeverage) throw new ExchangeError('LEVERAGE_UNSUPPORTED', `${this.id} does not expose setLeverage`, false);
    try { await client.setLeverage(leverage, this.marketSymbol(symbol)); return { symbol, leverage }; } catch (error) { throw this.normalize(error); }
  }
  async setMarginMode(symbol: string, mode: MarginMode): Promise<{ symbol: string; mode: MarginMode }> {
    const client = this.requireClient();
    if (!client.has.setMarginMode) throw new ExchangeError('MARGIN_MODE_UNSUPPORTED', `${this.id} does not expose setMarginMode`, false);
    try { await client.setMarginMode(mode.toLowerCase(), this.marketSymbol(symbol)); return { symbol, mode }; } catch (error) { throw this.normalize(error); }
  }
  async getOHLCV(symbol: string, timeframe = '1h', limit = 100): Promise<OHLCV[]> {
    const client = this.requireClient();
    if (!client.has.fetchOHLCV) throw new ExchangeError('OHLCV_UNSUPPORTED', `${this.id} does not expose fetchOHLCV`, false);
    try {
      const candles = await client.fetchOHLCV(this.marketSymbol(symbol), timeframe as never, undefined, Math.min(Math.max(1, Number(limit) || 100), 500));
      return candles.map(([timestamp, open, high, low, close, volume]) => ({ timestamp: new Date(Number(timestamp)).toISOString(), open: String(open), high: String(high), low: String(low), close: String(close), volume: String(volume) }));
    } catch (error) { throw this.normalize(error); }
  }
  async getFundingRate(symbol: string): Promise<FundingRate | null> {
    const client = this.requireClient();
    if (!client.has.fetchFundingRate) return null;
    try {
      const rate = await client.fetchFundingRate(this.marketSymbol(symbol));
      if (rate.fundingRate == null) return null;
      return { symbol: this.bareSymbol(String(rate.symbol ?? symbol)), fundingRate: String(rate.fundingRate), ...(typeof rate.nextFundingTimestamp === 'number' ? { nextFundingTime: new Date(rate.nextFundingTimestamp).toISOString() } : {}) };
    } catch (error) { throw this.normalize(error); }
  }
  async getOpenInterest(symbol: string): Promise<OpenInterest | null> {
    const client = this.requireClient();
    if (!client.has.fetchOpenInterest) return null;
    try {
      const openInterest = await client.fetchOpenInterest(this.marketSymbol(symbol));
      if (openInterest.openInterestAmount == null) return null;
      return { symbol: this.bareSymbol(String(openInterest.symbol ?? symbol)), openInterest: String(openInterest.openInterestAmount) };
    } catch (error) { throw this.normalize(error); }
  }
  private requireClient(): Exchange { if (!this.client) throw new ExchangeError('NOT_CONNECTED', `${this.id} adapter is disconnected`, false); return this.client; }
  private defaultType(): string { return resolveDefaultType(this.id, this.marketType); }
  private marketSymbol(symbol: string): string {
    const client = this.requireClient();
    return resolveMarketSymbol((client.markets ?? {}) as Record<string, CcxtMarketLike>, symbol, this.defaultType());
  }
  public resolveMarketSymbol(symbol: string): string { return this.marketSymbol(symbol); }
  private bareSymbol(symbol: string): string { return bareSymbol(symbol); }
  private mapType(type: OrderRequest['type']): string { return ({ MARKET: 'market', LIMIT: 'limit', STOP: 'stop', STOP_MARKET: 'stop_market', STOP_LIMIT: 'stop_limit', TAKE_PROFIT: 'take_profit', TAKE_PROFIT_MARKET: 'take_profit_market', TRAILING_STOP: 'trailing_stop_market' } as const)[type]; }
  private createOrderType(type: OrderRequest['type']): string {
    if (this.marketType !== 'SPOT') return this.mapType(type);
    switch (type) {
      case 'LIMIT':
      case 'STOP_LIMIT':
      case 'TAKE_PROFIT':
        return 'limit';
      default:
        return 'market';
    }
  }
  private mapOrder(order: { id?: unknown; clientOrderId?: unknown; symbol?: unknown; status?: unknown; side?: unknown; type?: unknown; amount?: unknown; filled?: unknown; average?: unknown; fee?: ({ cost?: unknown | undefined; currency?: unknown | undefined } | undefined); lastTradeTimestamp?: unknown; timestamp?: unknown }): ExchangeOrder { const updatedTimestamp = typeof order.lastTradeTimestamp === 'number' ? order.lastTradeTimestamp : typeof order.timestamp === 'number' ? order.timestamp : Date.now(); return { id: String(order.id), clientOrderId: String(order.clientOrderId ?? order.id), symbol: this.bareSymbol(String(order.symbol)), status: this.mapStatus(String(order.status ?? 'unknown')), side: String(order.side).toUpperCase() as 'BUY'|'SELL', type: String(order.type), quantity: String(order.amount ?? 0), filledQuantity: String(order.filled ?? 0), ...(order.average == null ? {} : { averagePrice: String(order.average) }), ...(order.fee && order.fee.cost != null && Number(order.fee.cost) !== 0 ? { fee: { cost: String(order.fee.cost), asset: String(order.fee.currency ?? '') } } : {}), rawStatus: String(order.status ?? 'unknown'), updatedAt: new Date(updatedTimestamp).toISOString() }; }
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
export type { Balance, ExchangeOrder, Position } from '@platform/exchange-core';
