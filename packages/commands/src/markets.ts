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

export async function readCachedMarkets(): Promise<{ markets: MarketInfo[]; source: 'memory' | 'db' } | null> {
  const hit = memory.get(CACHE_KEY);
  if (hit && hit.expiresAt > Date.now()) return { markets: hit.markets, source: 'memory' };
  const row = await prisma.marketCache.findUnique({ where: { key: CACHE_KEY } }).catch(() => null);
  if (row?.payload && Array.isArray(row.payload)) {
    const markets = row.payload as unknown as MarketInfo[];
    memory.set(CACHE_KEY, { expiresAt: Date.now() + MARKETS_TTL_MS, markets });
    return { markets, source: 'db' };
  }
  return null;
}

let refreshPromise: Promise<MarketsResult> | undefined;

async function refreshMarketsLive(): Promise<MarketsResult> {
  if (refreshPromise) return refreshPromise;
  const promise: Promise<MarketsResult> = (async (): Promise<MarketsResult> => {
    const { adapter } = await connectToAccount();
    try {
      const markets = await adapter.getMarkets(true);
      memory.set(CACHE_KEY, { expiresAt: Date.now() + MARKETS_TTL_MS, markets });
      await prisma.marketCache
        .upsert({
          where: { key: CACHE_KEY },
          update: { payload: markets as unknown as Prisma.InputJsonValue },
          create: { key: CACHE_KEY, payload: markets as unknown as Prisma.InputJsonValue },
        })
        .catch(() => undefined);
      return { markets, source: 'live', generatedAt: new Date().toISOString() };
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
  })().finally(() => { refreshPromise = undefined; });
  refreshPromise = promise;
  return promise;
}

export async function fetchMarketsCached(): Promise<MarketsResult> {
  const seeded = await readCachedMarkets();
  if (seeded) {
    void refreshMarketsLive().catch(() => undefined);
    return { markets: seeded.markets, source: seeded.source, generatedAt: new Date().toISOString() };
  }
  try {
    return await refreshMarketsLive();
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

export async function listExchangeMarkets(quote?: string, marketType?: string): Promise<MarketInfo[]> {
  const { markets } = await fetchMarketsCached();
  const typeFilter = marketType?.toUpperCase() === 'SPOT' ? 'spot' : marketType?.toUpperCase() === 'USDT_FUTURES' ? 'swap' : marketType?.toUpperCase() === 'COIN_FUTURES' ? 'delivery' : marketType?.toUpperCase() === 'PERPETUAL' ? 'perpetual' : marketType?.toUpperCase() === 'MARGIN' ? 'margin' : undefined;
  const filtered = markets.filter((market) => (quote ? market.quote.toUpperCase() === quote.toUpperCase() : true) && (typeFilter === undefined || market.type === typeFilter));
  return filtered.sort((a, b) => a.symbol.localeCompare(b.symbol));
}