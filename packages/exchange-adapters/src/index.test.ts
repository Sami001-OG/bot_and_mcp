import { describe, expect, it } from 'vitest';
import { mapExchangeStatus, resolveDefaultType } from './index.js';

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