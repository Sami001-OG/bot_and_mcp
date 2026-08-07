import { describe, expect, it } from 'vitest';
import { CommandError, buildRiskContext, parseOrderBody } from './index.js';

describe('commands', () => {
  it('builds a risk context with zeroed defaults', () => {
    const context = buildRiskContext({ equity: '1000', peakEquity: '1200', markPrice: '100' });
    expect(context).toEqual({ equity: '1000', dailyPnl: '0', weeklyPnl: '0', monthlyPnl: '0', peakEquity: '1200', exposure: '0', openPositions: 0, consecutiveLosses: 0, markPrice: '100' });
  });

  it('passes through caller-provided risk inputs', () => {
    const context = buildRiskContext({ equity: '1000', peakEquity: '1200', markPrice: '100', dailyPnl: '-500', openPositions: 3, enforceMinimumNotional: false });
    expect(context.dailyPnl).toBe('-500');
    expect(context.openPositions).toBe(3);
    expect(context.enforceMinimumNotional).toBe(false);
  });

  it('parses a valid order body with an explicit idempotency key', () => {
    const parsed = parseOrderBody({
      exchangeAccountId: 'acc-1',
      exchange: 'bybit',
      marketType: 'SPOT',
      symbol: 'btc/usdt',
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.01',
      clientOrderId: 'client-order-123',
      idempotencyKey: 'idem-key-1234567890abcdef'
    });
    expect(parsed.symbol).toBe('BTC/USDT');
    expect(parsed.quantity).toBe('0.01');
  });

  it('rejects an order with both quantity and allocation', () => {
    expect(() =>
      parseOrderBody({
        exchangeAccountId: 'acc-1',
        exchange: 'bybit',
        marketType: 'SPOT',
        symbol: 'btc/usdt',
        side: 'BUY',
        type: 'MARKET',
        quantity: '0.01',
        allocation: { mode: 'PERCENT_EQUITY', percent: 2 },
        clientOrderId: 'client-order-123',
        idempotencyKey: 'idem-key-1234567890abcdef'
      })
    ).toThrow();
  });

  it('exposes structured command errors', () => {
    const error = new CommandError(409, 'RISK_DENIED', 'Order rejected by risk engine', { risk: { approved: false } });
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('RISK_DENIED');
    expect(error.details?.risk).toEqual({ approved: false });
  });
});
