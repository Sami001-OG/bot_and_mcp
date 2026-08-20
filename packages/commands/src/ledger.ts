import { Prisma, prisma } from '@platform/database';
import type { MarginMode, PositionSide } from '@platform/contracts';
import type { Position } from '@platform/exchange-core';
import { computeRealizedPnl } from '@platform/trading-core';
import { connectToAccount } from './account.js';
import { getSettings, tripCircuitBreaker } from './settings.js';

export type CircuitBreaker = { ok: true } | { ok: false; reason: string; dailyPnl: string; limit: string; limitReached: boolean };

export async function checkCircuitBreaker(): Promise<CircuitBreaker> {
  const settings = await getSettings();
  if (settings.breakerTripped) {
    return { ok: false, reason: settings.breakerReason ?? 'Circuit breaker is tripped', dailyPnl: settings.breakerDailyPnl ?? '0', limit: settings.dailyLossLimit ?? '0', limitReached: true };
  }
  if (!settings.tradingEnabled) return { ok: false, reason: 'Live trading is disabled', dailyPnl: '0', limit: '0', limitReached: false };
  const dailyPnl = new Prisma.Decimal(await dailyRealizedPnl());
  if (settings.dailyLossLimit !== null) {
    const limit = new Prisma.Decimal(settings.dailyLossLimit);
    if (dailyPnl.lte(limit.negated())) {
      await tripCircuitBreaker(`Daily loss limit reached (${dailyPnl.toFixed(4)} vs limit ${limit.toFixed(4)})`, dailyPnl.toFixed(4));
      return { ok: false, reason: `Daily loss limit reached (${dailyPnl.toFixed(4)} vs limit ${limit.toFixed(4)})`, dailyPnl: dailyPnl.toFixed(4), limit: limit.toFixed(4), limitReached: true };
    }
  }
  return { ok: true };
}

export type LedgerPosition = { symbol: string; side: PositionSide; quantity: string; averageEntryPrice: string; markPrice: string; unrealizedPnl: string; leverage: number; liquidationPrice?: string; marginMode: MarginMode };

export async function syncPositionsFromExchange(): Promise<{ positions: LedgerPosition[] }> {
  const { adapter } = await connectToAccount();
  try {
    const positions = await adapter.getPositions();
    const mapped: LedgerPosition[] = positions.map((position) => ({ symbol: position.symbol, side: position.side, quantity: position.quantity, averageEntryPrice: position.entryPrice, markPrice: position.markPrice, unrealizedPnl: position.unrealizedPnl, leverage: position.leverage, ...(position.liquidationPrice ? { liquidationPrice: position.liquidationPrice } : {}), marginMode: position.marginMode }));
    const liveKeys = new Set<string>();
    for (const position of mapped) {
      const symbol = adapter.resolveMarketSymbol(position.symbol);
      liveKeys.add(`${symbol}|${position.side}`);
      await prisma.position.updateMany({
        where: { symbol, side: position.side },
        data: { markPrice: position.markPrice, unrealizedPnl: position.unrealizedPnl, leverage: position.leverage, marginMode: position.marginMode, ...(position.liquidationPrice ? { liquidationPrice: position.liquidationPrice } : { liquidationPrice: null }) },
      });
    }
    const stale = await prisma.position.findMany({ select: { id: true, symbol: true, side: true, quantity: true } });
    const staleIds = stale.filter((row) => Number(row.quantity) > 0 && !liveKeys.has(`${row.symbol}|${row.side}`)).map((row) => row.id);
    if (staleIds.length > 0) {
      await prisma.position.updateMany({ where: { id: { in: staleIds } }, data: { quantity: '0', unrealizedPnl: '0', markPrice: '0' } });
    }
    return { positions: mapped };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

export type LiveLedgerPosition = {
  symbol: string;
  side: PositionSide;
  quantity: string;
  averageEntryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  leverage: number;
  liquidationPrice?: string;
  marginMode: MarginMode;
  updatedAt: Date;
  live: boolean;
};

export async function liveLedgerPositions(): Promise<{ rows: LiveLedgerPosition[]; live: boolean }> {
  const rows = await listLedgerPositions();
  try {
    const { adapter } = await connectToAccount();
    try {
      const positions = await adapter.getPositions();
      const liveByKey = new Map<string, Position>();
      for (const position of positions) {
        liveByKey.set(`${adapter.resolveMarketSymbol(position.symbol)}|${position.side}`, position);
      }
      const overlaid: LiveLedgerPosition[] = rows.map((row) => {
        const live = liveByKey.get(`${row.symbol}|${row.side}`);
        if (live) {
          const base = {
            symbol: row.symbol,
            side: row.side,
            quantity: live.quantity,
            averageEntryPrice: live.entryPrice,
            markPrice: live.markPrice,
            unrealizedPnl: live.unrealizedPnl,
            realizedPnl: row.realizedPnl,
            leverage: live.leverage,
            marginMode: live.marginMode,
            updatedAt: row.updatedAt,
            live: true,
          };
          return live.liquidationPrice ? { ...base, liquidationPrice: live.liquidationPrice } : base;
        }
        if (Number(row.quantity) > 0) {
          return { symbol: row.symbol, side: row.side, quantity: '0', averageEntryPrice: row.averageEntryPrice, markPrice: '0', unrealizedPnl: '0', realizedPnl: row.realizedPnl, leverage: row.leverage, marginMode: row.marginMode, updatedAt: row.updatedAt, live: true };
        }
        return { symbol: row.symbol, side: row.side, quantity: row.quantity, averageEntryPrice: row.averageEntryPrice, markPrice: row.markPrice, unrealizedPnl: row.unrealizedPnl, realizedPnl: row.realizedPnl, leverage: row.leverage, ...(row.liquidationPrice ? { liquidationPrice: row.liquidationPrice } : {}), marginMode: row.marginMode, updatedAt: row.updatedAt, live: true };
      });
      return { rows: overlaid, live: true };
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
  } catch {
    return { rows: rows.map((row) => ({ ...row, live: false })), live: false };
  }
}

export async function realizedPnlInWindow(since: Date): Promise<Array<{ symbol: string; realizedPnl: string; fills: number }>> {
  const executions = await prisma.execution.findMany({
    where: { executedAt: { gte: since } },
    include: { orderIntent: { select: { symbol: true, side: true } } },
    orderBy: { executedAt: 'asc' },
  });
  const bySymbol = new Map<string, Array<{ side: 'BUY' | 'SELL'; quantity: string; price: string; fee: string }>>();
  for (const execution of executions) {
    const fills = bySymbol.get(execution.orderIntent.symbol) ?? [];
    fills.push({ side: execution.orderIntent.side as 'BUY' | 'SELL', quantity: execution.quantity, price: execution.price, fee: execution.fee });
    bySymbol.set(execution.orderIntent.symbol, fills);
  }
  return [...bySymbol.entries()].map(([symbol, fills]) => ({ symbol, realizedPnl: computeRealizedPnl(fills), fills: fills.length }));
}

export async function dailyRealizedPnl(): Promise<string> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rows = await realizedPnlInWindow(today);
  return rows.reduce((sum, row) => sum.add(new Prisma.Decimal(row.realizedPnl)), new Prisma.Decimal(0)).toFixed(8);
}

export async function listLedgerPositions(): Promise<Array<{ symbol: string; side: PositionSide; quantity: string; averageEntryPrice: string; markPrice: string; unrealizedPnl: string; realizedPnl: string; leverage: number; liquidationPrice?: string; marginMode: MarginMode; updatedAt: Date }>> {
  const rows = await prisma.position.findMany({ orderBy: { updatedAt: 'desc' } });
  return rows.map((row) => ({ symbol: row.symbol, side: row.side as PositionSide, quantity: row.quantity, averageEntryPrice: row.averageEntryPrice, markPrice: row.markPrice, unrealizedPnl: row.unrealizedPnl, realizedPnl: row.realizedPnl, leverage: row.leverage, ...(row.liquidationPrice ? { liquidationPrice: row.liquidationPrice } : {}), marginMode: row.marginMode as MarginMode, updatedAt: row.updatedAt }));
}