import { describe, expect, it } from 'vitest';
import { BreakevenConfigSchema, DcaConfigSchema, PartialTpsConfigSchema, TradingViewSignalSchema, WebhookBotConfigSchema, marketTypeForSymbol, type MarketType } from '@platform/contracts';
import { CommandError, breakevenTarget, buildRiskContext, dcaStepDue, managePrefix, mergeManagementOverrides, parseOrderBody, type AccountConfig } from './index.js';

const testConfig: AccountConfig = { id: 'acc-1', exchange: 'bybit', marketType: 'SPOT', label: 'test', apiKey: 'k', secret: 's' };

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

  it('parses a valid order body with an explicit idempotency key', async () => {
    const parsed = await parseOrderBody(
      {
        exchangeAccountId: 'acc-1',
        exchange: 'bybit',
        marketType: 'SPOT',
        symbol: 'btc/usdt',
        side: 'BUY',
        type: 'MARKET',
        quantity: '0.01',
        clientOrderId: 'client-order-123',
        idempotencyKey: 'idem-key-1234567890abcdef'
      },
      undefined,
      testConfig
    );
    expect(parsed.symbol).toBe('BTC/USDT');
    expect(parsed.quantity).toBe('0.01');
  });

  it('rejects an order with both quantity and allocation', async () => {
    await expect(
      parseOrderBody(
        {
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
        },
        undefined,
        testConfig
      )
    ).rejects.toThrow();
  });

  it('exposes structured command errors', () => {
    const error = new CommandError(409, 'RISK_DENIED', 'Order rejected by risk engine', { risk: { approved: false } });
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('RISK_DENIED');
    expect(error.details?.risk).toEqual({ approved: false });
  });

  it('builds deterministic manage order prefixes per kind, bot and symbol', () => {
    expect(managePrefix('dca', '65ab1234abcdef5678901234', 'BTC/USDT:USDT')).toBe('btdc-65ab1234-BTCUSDTU');
    expect(managePrefix('br', '65ab1234abcdef5678901234', 'ETH/USDT')).toBe('btbr-65ab1234-ETHUSDT');
    expect(managePrefix('tpr', '65ab1234abcdef5678901234', 'BTC/USDT:USDT')).toBe('bttp-65ab1234-BTCUSDTU');
    expect(managePrefix('tpc', '65ab1234abcdef5678901234', 'SOL/USDT')).toBe('btcl-65ab1234-SOLUSDT');
    expect(managePrefix('dca', '65ab1234abcdef5678901234', 'BTC/USDT:USDT')).not.toBe(managePrefix('dca', '65ab5678abcdef5678901234', 'BTC/USDT:USDT'));
  });

  it('schedules DCA steps by drop percent with progressive spacing', () => {
    const cfg = DcaConfigSchema.parse({ enabled: true, triggerDropPercent: 3, amountMode: 'FIXED', amount: 50, maxSteps: 3 });
    expect(dcaStepDue(cfg, 2.9, 0)).toBe(0);
    expect(dcaStepDue(cfg, 3, 0)).toBe(1);
    expect(dcaStepDue(cfg, 3, 1)).toBe(0);
    expect(dcaStepDue(cfg, 6, 1)).toBe(2);
    expect(dcaStepDue(cfg, 9, 2)).toBe(3);
    expect(dcaStepDue(cfg, 9, 3)).toBe(0);
  });

  it('supports custom DCA step spacing', () => {
    const cfg = DcaConfigSchema.parse({ enabled: true, triggerDropPercent: 2, stepDropPercent: 5, amountMode: 'PERCENT_EQUITY', amount: 10, maxSteps: 4 });
    expect(dcaStepDue(cfg, 2, 0)).toBe(1);
    expect(dcaStepDue(cfg, 4.9, 1)).toBe(0);
    expect(dcaStepDue(cfg, 7, 1)).toBe(2);
  });

  it('computes breakeven targets with and without safe profit', () => {
    expect(breakevenTarget('LONG', 100, BreakevenConfigSchema.parse({ enabled: true, moveAtProfitPercent: 2 }))).toBe(100);
    expect(breakevenTarget('SHORT', 100, BreakevenConfigSchema.parse({ enabled: true, moveAtProfitPercent: 2 }))).toBe(100);
    expect(breakevenTarget('LONG', 100, BreakevenConfigSchema.parse({ enabled: true, moveAtProfitPercent: 2, safeProfitPercent: 0.5 }))).toBeCloseTo(100.5);
    expect(breakevenTarget('SHORT', 100, BreakevenConfigSchema.parse({ enabled: true, moveAtProfitPercent: 2, safeProfitPercent: 0.5 }))).toBeCloseTo(99.5);
  });

  it('rejects partial TP levels that exceed 100% total close', () => {
    expect(() => PartialTpsConfigSchema.parse({ enabled: true, levels: [{ pricePercent: 2, closePercent: 30 }, { pricePercent: 5, closePercent: 40 }, { pricePercent: 10, closePercent: 30 }] })).not.toThrow();
    expect(() => PartialTpsConfigSchema.parse({ enabled: true, levels: [{ pricePercent: 2, closePercent: 60 }, { pricePercent: 5, closePercent: 60 }] })).toThrow();
  });

  it('accepts bot configs with and without the new management capabilities', () => {
    const base = { symbols: ['BTC/USDT:USDT'], leverage: 1 };
    expect(WebhookBotConfigSchema.parse(base).dca).toBeUndefined();
    const full = WebhookBotConfigSchema.parse({
      ...base,
      dca: { enabled: true, triggerDropPercent: 3, amountMode: 'FIXED', amount: 50, maxSteps: 3 },
      breakeven: { enabled: true, moveAtProfitPercent: 2 },
      partialTps: { enabled: true, levels: [{ pricePercent: 2, closePercent: 30 }, { pricePercent: 5, closePercent: 30 }] },
    });
    expect(full.dca?.maxSteps).toBe(3);
    expect(full.breakeven?.moveAtProfitPercent).toBe(2);
    expect(full.partialTps?.levels.length).toBe(2);
  });

  it('merges ephemeral management overrides over the saved config', () => {
    const base = WebhookBotConfigSchema.parse({
      symbols: ['BTC/USDT:USDT'],
      dca: { enabled: true, triggerDropPercent: 3, amountMode: 'FIXED', amount: 50, maxSteps: 3 },
    });
    const merged = mergeManagementOverrides(base, {
      dca: { triggerDropPercent: 6, amountMode: 'FIXED', amount: 100, maxSteps: 5 },
      breakeven: { moveAtProfitPercent: 1.5 },
    });
    expect(merged.dca?.triggerDropPercent).toBe(6);
    expect(merged.dca?.maxSteps).toBe(5);
    expect(merged.dca?.enabled).toBe(true);
    expect(merged.breakeven?.moveAtProfitPercent).toBe(1.5);
    expect(merged.breakeven?.enabled).toBe(true);
    expect(merged.partialTps).toBeUndefined();
  });

  it('keeps the saved config when overrides are absent', () => {
    const base = WebhookBotConfigSchema.parse({
      symbols: ['BTC/USDT:USDT'],
      dca: { enabled: true, triggerDropPercent: 3, amountMode: 'FIXED', amount: 50, maxSteps: 3 },
    });
    const merged = mergeManagementOverrides(base, undefined);
    expect(merged).toBe(base);
    expect(merged.dca?.enabled).toBe(true);
  });

  it('respects an explicit enabled:false override', () => {
    const base = WebhookBotConfigSchema.parse({
      symbols: ['BTC/USDT:USDT'],
      dca: { enabled: true, triggerDropPercent: 3, amountMode: 'FIXED', amount: 50, maxSteps: 3 },
    });
    const merged = mergeManagementOverrides(base, { dca: { enabled: false, triggerDropPercent: 3, amountMode: 'FIXED', amount: 50, maxSteps: 3 } });
    expect(merged.dca?.enabled).toBe(false);
  });

  it('parses signals with management overrides and the MANAGE action', () => {
    const parsed = TradingViewSignalSchema.parse({
      exchange: 'bybit',
      symbol: 'BTC/USDT:USDT',
      action: 'MANAGE',
      dca: { triggerDropPercent: 5, amountMode: 'FIXED', amount: 25, maxSteps: 2 },
      partialTps: { levels: [{ pricePercent: 2, closePercent: 50 }] },
      nonce: 'abcdefghijkl',
      timestamp: '2026-08-19T00:00:00.000Z'
    });
    expect(parsed.action).toBe('MANAGE');
    expect(parsed.dca?.maxSteps).toBe(2);
    expect(parsed.partialTps?.levels.length).toBe(1);
  });

  it('requires size on trade actions but rejects it on MANAGE', () => {
    const base = { exchange: 'bybit', symbol: 'BTC/USDT:USDT', nonce: 'abcdefghijkl', timestamp: '2026-08-19T00:00:00.000Z' };
    expect(() => TradingViewSignalSchema.parse({ ...base, action: 'BUY' })).toThrow();
    expect(() => TradingViewSignalSchema.parse({ ...base, action: 'BUY', size: '0.01' })).not.toThrow();
    expect(() => TradingViewSignalSchema.parse({ ...base, action: 'MANAGE', size: '0.01' })).toThrow();
  });

  it('derives marketType from symbol format via marketTypeForSymbol', () => {
    expect(marketTypeForSymbol('BTC/USDT:USDT')).toBe('USDT_FUTURES');
    expect(marketTypeForSymbol('BTC/USDT')).toBe('SPOT');
    expect(marketTypeForSymbol('ETH/USDT:USDT')).toBe('USDT_FUTURES');
    expect(marketTypeForSymbol('SOL/USDT')).toBe('SPOT');
    expect(marketTypeForSymbol('DOGE/USDT:USDT')).toBe('USDT_FUTURES');
    expect(marketTypeForSymbol('DOGE/USDT')).toBe('SPOT');
    expect(marketTypeForSymbol('BTC/USD:BTCUSD')).toBe('COIN_FUTURES');
    expect(marketTypeForSymbol('ETH/USD:ETHUSD')).toBe('COIN_FUTURES');
    expect(marketTypeForSymbol('SOL/USDT:SOL')).toBe('COIN_FUTURES');
  });
});