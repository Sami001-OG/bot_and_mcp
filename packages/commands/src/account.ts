import { prisma, Prisma } from '@platform/database';
import { createExchangeAdapter } from '@platform/exchange-adapters';
import { ExchangeError, type ExchangeAdapter, type ExchangeConnection, type MarketInfo, type MarketPrecision } from '@platform/exchange-core';
import type { ExchangeId, MarketType } from '@platform/contracts';
import { getSettings, updateSettings } from './settings.js';
import { getAccountSecret, getPrimaryAccount } from './exchange-accounts.js';

export type AccountConfig = { id: string; exchange: ExchangeId; marketType: MarketType; label: string; apiKey: string; secret: string };

function labelOf(exchange: string, marketType: string): string {
  return `${exchange} ${marketType === 'SPOT' ? 'Spot' : marketType === 'USDT_FUTURES' ? 'USDT Futures' : marketType === 'COIN_FUTURES' ? 'Coin Futures' : marketType}`;
}

export async function getAccountConfig(accountId?: string): Promise<AccountConfig> {
  const resolved = accountId ? await getAccountSecret(accountId) : await getPrimaryAccount();
  return {
    id: resolved.account.id,
    exchange: resolved.exchange.toLowerCase() as ExchangeId,
    marketType: resolved.marketType.toUpperCase() as MarketType,
    label: resolved.account.label ?? labelOf(resolved.exchange, resolved.marketType),
    apiKey: resolved.apiKey,
    secret: resolved.secret,
  };
}

export async function connectToAccount(accountId?: string): Promise<{ adapter: ExchangeAdapter; connection: ExchangeConnection; config: AccountConfig }> {
  const config = await getAccountConfig(accountId);
  const adapter = createExchangeAdapter(config.exchange, config.marketType);
  try {
    const connection = await adapter.connect({ apiKey: config.apiKey, secret: config.secret });
    return { adapter, connection, config };
  } catch (error) {
    await adapter.disconnect().catch(() => undefined);
    throw error;
  }
}

export async function resolveMarketSnapshot(symbol: string, requestPrice?: string, includePrecision = true): Promise<{ price: string; equity: string; maxEquity: string; precision: MarketPrecision | null }> {
  const { adapter } = await connectToAccount();
  try {
    const price = requestPrice ?? (await adapter.getPrice(symbol));
    const precision = includePrecision ? await marketPrecisionOf(adapter, symbol) : null;
    const balances = await adapter.getBalance();
    const quote = (symbol.split('/')[1] ?? 'USDT').split(':')[0];
    const balance = balances.find((entry) => entry.asset === quote);
    const equity = balance ? balance.total : '0';
    const settings = await getSettings();
    const previousEquity = settings.equity;
    const previousPeak = settings.peakEquity;
    const maxEquity = previousPeak === null ? (previousEquity === null ? equity : previousEquity) : Prisma.Decimal.max(new Prisma.Decimal(previousPeak), new Prisma.Decimal(equity)).toString();
    await updateSettings({ equity, peakEquity: maxEquity });
    return { price, equity, maxEquity, precision };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

const marketPrecisionCache = new Map<string, { expiresAt: number; precision: MarketPrecision | null }>();
const MARKET_PRECISION_TTL_MS = 10 * 60_000;

export async function marketPrecisionOf(adapter: ExchangeAdapter, symbol: string): Promise<MarketPrecision | null> {
  const key = `${adapter.id}|${symbol.toUpperCase()}`;
  const hit = marketPrecisionCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.precision;
  let precision: MarketPrecision | null = null;
  try {
    const markets: MarketInfo[] = await adapter.getMarkets().catch(() => []);
    const match = markets.find((market) => market.symbol.toUpperCase() === symbol.toUpperCase());
    if (match) precision = { ...(match.amountStep !== undefined ? { amountStep: match.amountStep } : {}), ...(match.amountMin !== undefined ? { amountMin: match.amountMin } : {}), ...(match.priceStep !== undefined ? { priceStep: match.priceStep } : {}), ...(match.priceMin !== undefined ? { priceMin: match.priceMin } : {}) };
  } catch { /* precision is advisory; order flow continues unaligned */ }
  marketPrecisionCache.set(key, { expiresAt: Date.now() + MARKET_PRECISION_TTL_MS, precision });
  return precision;
}