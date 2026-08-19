import { Prisma, prisma } from '@platform/database';
import { type MarketInfo } from '@platform/exchange-core';
import { connectToAccount } from './account.js';

const MARKETS_TTL_MS = 15 * 60_000;
const CACHE_KEY = 'markets';

type MemoryEntry = { expiresAt: number; markets: MarketInfo[] };

const memory = new Map<string, MemoryEntry>();

export type MarketsResult = {
  markets: MarketInfo[];
  source: 'live' | 'memory' | 'db' | 'stale';
  generatedAt: string;
  error?: string;
};

export async function fetchMarketsCached(): Promise<MarketsResult> {
  const hit = memory.get(CACHE_KEY);
  if (hit && hit.expiresAt > Date.now()) {
    return { markets: hit.markets, source: 'memory', generatedAt: new Date().toISOString() };
  }
  try {
    const { adapter } = await connectToAccount();
    let markets: MarketInfo[];
    try {
      markets = await adapter.getMarkets();
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
    memory.set(CACHE_KEY, { expiresAt: Date.now() + MARKETS_TTL_MS, markets });
    await prisma.marketCache
      .upsert({
        where: { key: CACHE_KEY },
        update: { payload: markets as unknown as Prisma.InputJsonValue },
        create: { key: CACHE_KEY, payload: markets as unknown as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
    return { markets, source: 'live', generatedAt: new Date().toISOString() };
  } catch (error) {
    const row = await prisma.marketCache.findUnique({ where: { key: CACHE_KEY } }).catch(() => null);
    if (row?.payload && Array.isArray(row.payload)) {
      const markets = row.payload as unknown as MarketInfo[];
      memory.set(CACHE_KEY, { expiresAt: Date.now() + MARKETS_TTL_MS, markets });
      return {
        markets,
        source: 'stale',
        generatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}

export async function listExchangeMarkets(quote?: string): Promise<MarketInfo[]> {
  const { markets } = await fetchMarketsCached();
  const filtered = quote ? markets.filter((market) => market.quote.toUpperCase() === quote.toUpperCase()) : markets;
  return filtered.sort((a, b) => a.symbol.localeCompare(b.symbol));
}