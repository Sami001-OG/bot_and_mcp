import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { TradingViewWebhookVerifier } from './index.js';

const secret = 'test-signing-secret';
const now = Date.parse('2026-08-06T20:00:00.000Z');

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    exchange: 'bybit',
    symbol: 'BTC/USDT',
    action: 'BUY',
    size: '0.001',
    stop_loss: '50000',
    take_profit: ['65000'],
    reduce_only: false,
    nonce: 'n-123456789012',
    timestamp: new Date(now).toISOString(),
    ...overrides
  });
}

function sign(body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function fakeStore(claims: Array<{ key: string; ttl: number }> = [], available = true): { store: { claim: (key: string, ttlSeconds: number) => Promise<boolean> }; claims: typeof claims } {
  return {
    store: { claim: async (key: string, ttlSeconds: number) => { claims.push({ key, ttl: ttlSeconds }); return available; } },
    claims
  };
}

describe('TradingViewWebhookVerifier', () => {
  it('accepts a validly signed, fresh, unique webhook and returns the parsed signal', async () => {
    const body = payload();
    const store = fakeStore();
    const verifier = new TradingViewWebhookVerifier(secret, store.store);
    const signal = await verifier.verify(body, sign(body), now);
    expect(signal).toMatchObject({ exchange: 'bybit', symbol: 'BTC/USDT', action: 'BUY', size: '0.001', nonce: 'n-123456789012' });
    expect(store.claims).toEqual([{ key: 'bybit:n-123456789012', ttl: 300 }]);
  });

  it('rejects a tampered signature', async () => {
    const body = payload();
    const verifier = new TradingViewWebhookVerifier(secret, fakeStore().store);
    const tampered = sign(body).slice(0, 8) + '0'.repeat(56);
    await expect(verifier.verify(body, tampered, now)).rejects.toThrow('Invalid webhook signature');
  });

  it('rejects a body signed with a different secret', async () => {
    const body = payload();
    const verifier = new TradingViewWebhookVerifier('other-secret', fakeStore().store);
    await expect(verifier.verify(body, sign(body), now)).rejects.toThrow('Invalid webhook signature');
  });

  it('rejects a stale timestamp outside the tolerance window', async () => {
    const body = payload({ timestamp: new Date(now - 11 * 60_000).toISOString() });
    const verifier = new TradingViewWebhookVerifier(secret, fakeStore().store);
    await expect(verifier.verify(body, sign(body), now)).rejects.toThrow('Webhook timestamp outside tolerance');
  });

  it('rejects a replayed nonce when the store refuses the claim', async () => {
    const body = payload();
    const store = fakeStore([], false);
    const verifier = new TradingViewWebhookVerifier(secret, store.store);
    await expect(verifier.verify(body, sign(body), now)).rejects.toThrow('Webhook replay detected');
  });

  it('respects a custom tolerance window', async () => {
    const body = payload({ timestamp: new Date(now - 3 * 60_000).toISOString() });
    const verifier = new TradingViewWebhookVerifier(secret, fakeStore().store, 2 * 60_000);
    await expect(verifier.verify(body, sign(body), now)).rejects.toThrow('Webhook timestamp outside tolerance');
  });

  it('rejects malformed JSON bodies', async () => {
    const body = 'not-json-at-all';
    const verifier = new TradingViewWebhookVerifier(secret, fakeStore().store);
    await expect(verifier.verify(body, sign(body), now)).rejects.toThrow();
  });

  it('rejects bodies failing schema validation even with a valid signature', async () => {
    const body = JSON.stringify({ exchange: 'bybit', symbol: 'BTC/USDT', action: 'NOT_REAL', size: '0.001', nonce: 'fpce-123456789012', timestamp: new Date(now).toISOString() });
    const verifier = new TradingViewWebhookVerifier(secret, fakeStore().store);
    await expect(verifier.verify(body, sign(body), now)).rejects.toThrow();
  });
});