import type { McpClient } from '@platform/database';
import { hashToken } from '@platform/security';

export function tokenHashOf(token: string): string {
  return hashToken(token);
}

export function activeGrant(client: McpClient | null | undefined, now = new Date()): boolean {
  if (!client) return false;
  if (client.revokedAt !== null) return false;
  if (client.expiresAt <= now) return false;
  return true;
}

export function toolAllowed(client: McpClient, tool: string): boolean {
  if (client.allowedTools.length === 0 || client.allowedTools.includes('*')) return true;
  return client.allowedTools.includes(tool);
}

export function accountAllowed(client: McpClient, accountId: string): boolean {
  if (client.allowedExchangeAccountIds.length === 0 || client.allowedExchangeAccountIds.includes('*')) return true;
  return client.allowedExchangeAccountIds.includes(accountId);
}

export function symbolAllowed(client: McpClient, symbol: string): boolean {
  if (client.allowedSymbols.length === 0 || client.allowedSymbols.includes('*')) return true;
  const normalized = symbol.toUpperCase();
  const base = normalized.split('/')[0] ?? '';
  return client.allowedSymbols.some((entry) => {
    const expected = entry.toUpperCase();
    return expected === normalized || expected === base;
  });
}

export function leverageAllowed(client: McpClient, leverage: number): boolean {
  return client.maxLeverage <= 0 || leverage <= client.maxLeverage;
}

export function notionalAllowed(client: McpClient, notionalUsd: string): boolean {
  const limit = Number(client.maxNotional);
  const notional = Number(notionalUsd);
  if (!Number.isFinite(limit) || !Number.isFinite(notional) || limit < 0 || notional < 0) return false;
  return notional <= limit;
}

export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}