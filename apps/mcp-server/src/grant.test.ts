import { describe, expect, it } from 'vitest';
import type { McpClient } from '@platform/database';
import { accountAllowed, activeGrant, leverageAllowed, notionalAllowed, symbolAllowed, tokenHashOf, toolAllowed } from './grant.js';

function client(overrides: {
  allowedTools?: string[];
  allowedExchangeAccountIds?: string[];
  allowedSymbols?: string[];
  maxLeverage?: number;
  maxNotional?: number;
  expiresAt?: Date;
  revokedAt?: Date | null;
} = {}): McpClient {
  return {
    id: 'grant-1',
    workspaceId: 'ws-1',
    name: 'test',
    tokenHash: 'hash',
    allowedTools: overrides.allowedTools ?? [],
    allowedExchangeAccountIds: overrides.allowedExchangeAccountIds ?? [],
    allowedSymbols: overrides.allowedSymbols ?? [],
    maxLeverage: overrides.maxLeverage ?? 5,
    maxNotional: overrides.maxNotional ?? 5000,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
    revokedAt: overrides.revokedAt ?? null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    invocations: [],
  } as unknown as McpClient;
}

describe('tokenHashOf', () => {
  it('produces a stable sha256 hex', () => {
    expect(tokenHashOf('abc')).toBe(tokenHashOf('abc'));
    expect(tokenHashOf('abc')).not.toBe(tokenHashOf('abd'));
  });
});

describe('activeGrant', () => {
  it('accepts an active, non-expired grant', () => {
    expect(activeGrant(client())).toBe(true);
  });
  it('rejects revoked grants', () => {
    expect(activeGrant(client({ revokedAt: new Date('2026-01-02T00:00:00.000Z') }))).toBe(false);
  });
  it('rejects expired grants', () => {
    const now = new Date();
    expect(activeGrant(client({ expiresAt: new Date(now.getTime() - 1000) }), now)).toBe(false);
  });
  it('rejects null/undefined', () => {
    expect(activeGrant(null)).toBe(false);
    expect(activeGrant(undefined)).toBe(false);
  });
});

describe('toolAllowed', () => {
  it('allows all tools when the allowlist is empty', () => {
    expect(toolAllowed(client(), 'getBalance')).toBe(true);
    expect(toolAllowed(client(), 'placeOrder')).toBe(true);
  });
  it('allows everything with the * wildcard', () => {
    expect(toolAllowed(client({ allowedTools: ['*'] }), 'anything')).toBe(true);
  });
  it('restricts to the allowlist', () => {
    const granted = client({ allowedTools: ['getBalance', 'getPositions'] });
    expect(toolAllowed(granted, 'getBalance')).toBe(true);
    expect(toolAllowed(granted, 'placeOrder')).toBe(false);
  });
});

describe('accountAllowed', () => {
  it('allows all accounts for an empty allowlist', () => {
    expect(accountAllowed(client(), 'acc-1')).toBe(true);
  });
  it('restricts to the allowlist and supports *', () => {
    expect(accountAllowed(client({ allowedExchangeAccountIds: ['acc-1'] }), 'acc-1')).toBe(true);
    expect(accountAllowed(client({ allowedExchangeAccountIds: ['acc-1'] }), 'acc-2')).toBe(false);
    expect(accountAllowed(client({ allowedExchangeAccountIds: ['*'] }), 'acc-99')).toBe(true);
  });
});

describe('symbolAllowed', () => {
  it('allows all symbols when the allowlist is empty', () => {
    expect(symbolAllowed(client(), 'BTC/USDT')).toBe(true);
  });
  it('matches exact symbols case-insensitively', () => {
    expect(symbolAllowed(client({ allowedSymbols: ['btc/usdt'] }), 'BTC/USDT')).toBe(true);
    expect(symbolAllowed(client({ allowedSymbols: ['ETH/USDT'] }), 'BTC/USDT')).toBe(false);
  });
  it('matches a base-currency allowlist entry', () => {
    expect(symbolAllowed(client({ allowedSymbols: ['BTC'] }), 'BTC/USDT')).toBe(true);
    expect(symbolAllowed(client({ allowedSymbols: ['BTC'] }), 'BTC/USDT:USDT')).toBe(true);
    expect(symbolAllowed(client({ allowedSymbols: ['BTC'] }), 'ETH/USDT')).toBe(false);
  });
  it('supports the * wildcard', () => {
    expect(symbolAllowed(client({ allowedSymbols: ['*'] }), 'DOGE/USDT')).toBe(true);
  });
});

describe('leverageAllowed', () => {
  it('caps leverage at the grant limit', () => {
    expect(leverageAllowed(client({ maxLeverage: 5 }), 5)).toBe(true);
    expect(leverageAllowed(client({ maxLeverage: 5 }), 6)).toBe(false);
  });
  it('does not cap when the limit is 0', () => {
    expect(leverageAllowed(client({ maxLeverage: 0 }), 100)).toBe(true);
  });
});

describe('notionalAllowed', () => {
  it('enforces the grant notional cap', () => {
    expect(notionalAllowed(client({ maxNotional: 5000 }), '4999')).toBe(true);
    expect(notionalAllowed(client({ maxNotional: 5000 }), '5001')).toBe(false);
  });
  it('rejects non-numeric inputs', () => {
    expect(notionalAllowed(client(), 'abc')).toBe(false);
    expect(notionalAllowed(client(), '-1')).toBe(false);
  });
});