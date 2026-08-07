import { describe, expect, it } from 'vitest';
import { bareSymbol, mapExchangeStatus, matchOrderByClientOrderId, resolveDefaultType, resolveMarketSymbol, type ExchangeOrder } from './index.js';

const baseOrder: ExchangeOrder = { id: 'e1', clientOrderId: 'wh-abc', symbol: 'BTC/USDT:USDT', status: 'NEW', side: 'BUY', type: 'MARKET', quantity: '1', filledQuantity: '0', rawStatus: 'New', updatedAt: '' };

describe('exchange adapter mappings', () => {
  it('maps ccxt and raw statuses to unified order states', () => {
    expect(mapExchangeStatus('NEW')).toBe('NEW');
    expect(mapExchangeStatus('open')).toBe('NEW');
    expect(mapExchangeStatus('PARTIALLY_FILLED')).toBe('PARTIALLY_FILLED');
    expect(mapExchangeStatus('partially_filled')).toBe('PARTIALLY_FILLED');
    expect(mapExchangeStatus('closed')).toBe('FILLED');
    expect(mapExchangeStatus('canceled')).toBe('CANCELED');
    expect(mapExchangeStatus('rejected')).toBe('REJECTED');
    expect(mapExchangeStatus('expired')).toBe('EXPIRED');
    expect(mapExchangeStatus('weird')).toBe('UNKNOWN');
  });

  it('resolves Bybit USDT perpetual as swap and Binance USDT futures as future', () => {
    expect(resolveDefaultType('binance', 'USDT_FUTURES')).toBe('future');
    expect(resolveDefaultType('bybit', 'USDT_FUTURES')).toBe('swap');
    expect(resolveDefaultType('bybit', 'PERPETUAL')).toBe('swap');
    expect(resolveDefaultType('binance', 'COIN_FUTURES')).toBe('delivery');
    expect(resolveDefaultType('binance', 'SPOT')).toBe('spot');
    expect(resolveDefaultType('bybit', 'SPOT')).toBe('spot');
  });
});

describe('resolveMarketSymbol', () => {
  const markets: Record<string, CcxtMarketLike> = {
    'DOGE/USDT': { symbol: 'DOGE/USDT', type: 'spot', base: 'DOGE', quote: 'USDT', active: true },
    'DOGE/USDT:USDT': { symbol: 'DOGE/USDT:USDT', type: 'swap', base: 'DOGE', quote: 'USDT', active: true },
    'BTC/USDT': { symbol: 'BTC/USDT', type: 'spot', base: 'BTC', quote: 'USDT', active: true },
    'BTC/USDT:USDT': { symbol: 'BTC/USDT:USDT', type: 'swap', base: 'BTC', quote: 'USDT', active: true },
  };

  it('keeps the same symbol spot for already-matching market types', () => {
    expect(resolveMarketSymbol(markets, 'DOGE/USDT', 'spot')).toBe('DOGE/USDT');
    expect(resolveMarketSymbol(markets, 'BTC/USDT:USDT', 'swap')).toBe('BTC/USDT:USDT');
  });

  it('resolves a bare base/quote symbol to the futures market when expected', () => {
    expect(resolveMarketSymbol(markets, 'DOGE/USDT', 'swap')).toBe('DOGE/USDT:USDT');
  });

  it('falls back to the exact match when none of the expected type exists', () => {
    expect(resolveMarketSymbol(markets, 'BTC/USDT:USDT', 'delivery')).toBe('BTC/USDT:USDT');
  });

  it('returns the symbol unchanged when it cannot resolve base/quote', () => {
    expect(resolveMarketSymbol(markets, 'nonsense', 'swap')).toBe('nonsense');
  });

  it('strips settlement suffixes from ccxt symbols', () => {
    expect(bareSymbol('DOGE/USDT:USDT')).toBe('DOGE/USDT');
    expect(bareSymbol('DOGE/USDT')).toBe('DOGE/USDT');
  });
});

type CcxtMarketLike = { symbol: string; type?: unknown; base?: unknown; quote?: unknown; active?: unknown };

describe('matchOrderByClientOrderId', () => {
  it('returns null for empty order lists', () => {
    expect(matchOrderByClientOrderId([], 'wh-abc')).toBeNull();
  });

  it('matches an order by clientOrderId ignoring case', () => {
    const orders = [baseOrder, { ...baseOrder, id: 'e2', clientOrderId: 'wh-DIFFERENT', status: 'FILLED' as const }];
    const found = matchOrderByClientOrderId(orders, 'WH-ABC');
    expect(found).toBeDefined();
    expect(found?.id).toBe('e1');
  });

  it('matches an order by exchange order id', () => {
    const orders = [baseOrder, { ...baseOrder, id: 'e2', clientOrderId: 'other' }];
    expect(matchOrderByClientOrderId(orders, 'E1')?.id).toBe('e1');
  });

  it('returns null when no order matches', () => {
    expect(matchOrderByClientOrderId([baseOrder], 'does-not-exist')).toBeNull();
  });
});
