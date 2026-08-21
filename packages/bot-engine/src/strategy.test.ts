import { describe, expect, it } from 'vitest';
import { buildWebhookOrders } from './index.js';
import type { TradingViewSignal, WebhookBotConfig } from '@platform/contracts';

const account = { id: 'acc-1', exchange: 'bybit', marketType: 'USDT_FUTURES' as const };

function signal(overrides: Partial<TradingViewSignal> = {}): TradingViewSignal {
  return { exchange: 'bybit', symbol: 'BTC/USDT', action: 'BUY', size: '0.01', nonce: 'n-123456789012', timestamp: new Date().toISOString(), reduce_only: false, ...overrides };
}

function config(overrides: Partial<WebhookBotConfig> = {}): WebhookBotConfig {
  return { symbols: ['BTC/USDT'], requireSignalStopLoss: false, ...overrides };
}

describe('buildWebhookOrders', () => {
  it('builds entry + stop-loss + take-profit bracket for BUY', () => {
    const result = buildWebhookOrders({ signal: signal(), config: config({ stopLoss: '90000', takeProfits: ['100000', '110000'] }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.skipped).toEqual([]);
    expect(result.orders).toHaveLength(4);
    const [entry, sl, tp1, tp2] = result.orders;
    if (!entry || !sl || !tp1 || !tp2) throw new Error('expected 4 orders');
    expect(entry).toMatchObject({ side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.01', reduceOnly: false, idempotencyKey: 'n-123456789012:entry' });
    expect(sl).toMatchObject({ side: 'SELL', type: 'STOP_MARKET', stopPrice: '90000', reduceOnly: true, idempotencyKey: 'n-123456789012:sl' });
    expect(tp1).toMatchObject({ side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: '100000', reduceOnly: true, quantity: '0.00500000', idempotencyKey: 'n-123456789012:tp:0' });
    expect(tp2).toMatchObject({ side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: '110000', reduceOnly: true, quantity: '0.00500000', idempotencyKey: 'n-123456789012:tp:1' });
  });

  it('builds a LIMIT entry with brackets validated against the limit price', () => {
    const result = buildWebhookOrders({ signal: signal({ type: 'LIMIT', price: '92000' }), config: config({ stopLoss: '90000', takeProfits: ['100000'] }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.skipped).toEqual([]);
    expect(result.orders).toHaveLength(3);
    const [entry, sl, tp] = result.orders;
    if (!entry || !sl || !tp) throw new Error('expected 3 orders');
    expect(entry).toMatchObject({ type: 'LIMIT', price: '92000', timeInForce: 'GTC', side: 'BUY', positionSide: 'LONG', reduceOnly: false });
    expect(sl).toMatchObject({ type: 'STOP_MARKET', stopPrice: '90000', reduceOnly: true });
  });

  it('skips a LIMIT entry whose stop loss sits above the limit price for a LONG', () => {
    const result = buildWebhookOrders({ signal: signal({ type: 'LIMIT', price: '92000' }), config: config({ stopLoss: '93000' }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('not below entry');
  });

  it('config stopLoss and takeProfits override signal values', () => {
    const result = buildWebhookOrders({ signal: signal({ stop_loss: '88000', take_profit: ['99000'] }), config: config({ stopLoss: '87000', takeProfits: ['98000'] }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders.map((order) => order.stopPrice)).toContain('87000');
    expect(result.orders.map((order) => order.stopPrice)).toContain('98000');
  });

  it('sizes entry from allocation when configured', () => {
    const result = buildWebhookOrders({ signal: signal(), config: config({ allocation: { mode: 'FIXED_AMOUNT', amount: '1000' }, leverage: 10 }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.skipped).toEqual([]);
    const entry = result.orders[0];
    if (!entry) throw new Error('expected entry order');
    expect(entry.quantity).toBe((1000 / 95000).toFixed(8));
    expect(entry.leverage).toBe(10);
  });

  it('skips when allocation sizing falls below minimum notional', () => {
    const result = buildWebhookOrders({ signal: signal(), config: config({ allocation: { mode: 'FIXED_AMOUNT', amount: '1' } }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('minimum');
  });

  it('skips symbol not in bot symbols', () => {
    const result = buildWebhookOrders({ signal: signal({ symbol: 'ETH/USDT' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('Symbol');
  });

  it('skips actions filtered by bot config', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'SELL' }), config: config({ actions: ['BUY'] }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('not in configured bot actions');
  });

  it('skips entry when stop loss is required but absent', () => {
    const result = buildWebhookOrders({ signal: signal(), config: config({ requireSignalStopLoss: true }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('Stop loss');
  });

  it('rejects signals for a different exchange', () => {
    const result = buildWebhookOrders({ signal: signal({ exchange: 'binance' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('Exchange');
  });

  it('builds reduce-only close for CLOSE_LONG', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'CLOSE_LONG' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(1);
    const close = result.orders[0];
    if (!close) throw new Error('expected close order');
    expect(close).toMatchObject({ side: 'SELL', positionSide: 'LONG', reduceOnly: true, quantity: '0.01', idempotencyKey: 'n-123456789012:close' });
  });

  it('partial exit closes a percentage of the position', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'PARTIAL_EXIT', close_percentage: 25 }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000', currentPositionSide: 'LONG', positionQuantity: 0.01 });
    expect(result.orders).toHaveLength(1);
    const close = result.orders[0];
    if (!close) throw new Error('expected partial exit order');
    expect(close).toMatchObject({ side: 'SELL', positionSide: 'LONG', reduceOnly: true });
    expect(Number(close.quantity)).toBeCloseTo(0.0025);
  });

  it('close orders size from the real position quantity when available', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'CLOSE_LONG', size: '0.5' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000', positionQuantity: 0.125 });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({ quantity: '0.125', idempotencyKey: 'n-123456789012:close' });
  });

  it('skips close when quantity is zero or empty', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'CLOSE_LONG', size: '0' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('positive position quantity');
  });

  it('reverse on a flat position is skipped', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'REVERSE', size: '0.005' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000', currentPositionSide: 'LONG', positionQuantity: 0 });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('non-zero position');
  });

  it('partial exit requires position state', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'PARTIAL_EXIT' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('position state');
  });

  it('reverse closes the existing side and opens the opposite', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'REVERSE', size: '0.005' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000', currentPositionSide: 'LONG', positionQuantity: 0.005 });
    expect(result.orders).toHaveLength(2);
    const close = result.orders[0];
    const entry = result.orders[1];
    if (!close || !entry) throw new Error('expected 2 orders');
    expect(close).toMatchObject({ side: 'SELL', positionSide: 'LONG', reduceOnly: true, quantity: '0.005' });
    expect(entry).toMatchObject({ side: 'SELL', positionSide: 'SHORT', reduceOnly: false });
  });

  it('reverse without position state is skipped', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'REVERSE' }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('position state');
  });

  it('skips unsupported actions like SET_LEVERAGE', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'SET_LEVERAGE', leverage: 5 }), config: config(), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(0);
    expect(result.skipped[0]).toContain('not supported');
  });

  it('attaches a trailing stop bracket from the signal override', () => {
    const result = buildWebhookOrders({ signal: signal({ trailing: { callbackPercent: 1.5 }, symbol: 'BTC/USDT:USDT' }), config: config({ symbols: ['BTC/USDT:USDT'] }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    expect(result.skipped).toEqual([]);
    const trailing = result.orders.find((order) => order.type === 'TRAILING_STOP');
    if (!trailing) throw new Error('expected trailing stop order');
    expect(trailing).toMatchObject({ side: 'SELL', positionSide: 'LONG', stopPrice: '96425.00000000', callbackRate: '1.5', reduceOnly: true, idempotencyKey: 'n-123456789012:tr' });
  });

  it('activates the trailing stop in the favorable direction for a short', () => {
    const result = buildWebhookOrders({ signal: signal({ action: 'SHORT', trailing: { callbackPercent: 2 }, symbol: 'BTC/USDT:USDT' }), config: config({ symbols: ['BTC/USDT:USDT'] }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    const trailing = result.orders.find((order) => order.type === 'TRAILING_STOP');
    if (!trailing) throw new Error('expected trailing stop order');
    expect(trailing).toMatchObject({ side: 'BUY', positionSide: 'SHORT', stopPrice: '93100.00000000', callbackRate: '2', reduceOnly: true });
  });

  it('attaches a trailing stop from the saved bot config', () => {
    const result = buildWebhookOrders({ signal: signal({ symbol: 'BTC/USDT:USDT' }), config: config({ symbols: ['BTC/USDT:USDT'], trailing: { enabled: true, callbackPercent: 2 } }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    const trailing = result.orders.find((order) => order.type === 'TRAILING_STOP');
    if (!trailing) throw new Error('expected trailing stop order');
    expect(trailing).toMatchObject({ callbackRate: '2' });
    expect(result.orders).toHaveLength(2);
  });

  it('keeps a fixed stop loss alongside the trailing stop', () => {
    const result = buildWebhookOrders({ signal: signal({ trailing: { callbackPercent: 1.5 }, symbol: 'BTC/USDT:USDT' }), config: config({ symbols: ['BTC/USDT:USDT'], stopLoss: '90000' }), account, price: '95000', equity: '1000', maxEquity: '1000' });
    const types = result.orders.map((order) => order.type);
    expect(types).toContain('STOP_MARKET');
    expect(types).toContain('TRAILING_STOP');
  });

  it('skips the trailing stop when the market price is unavailable', () => {
    const result = buildWebhookOrders({ signal: signal({ trailing: { callbackPercent: 1.5 } }), config: config(), account, equity: '1000', maxEquity: '1000' });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({ type: 'MARKET' });
    expect(result.skipped[0]).toContain('Trailing stop skipped');
  });
});
