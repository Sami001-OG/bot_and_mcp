import { Prisma, prisma } from '@platform/database';
import type { MarginMode, PositionSide } from '@platform/contracts';
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
    for (const position of mapped) {
      await prisma.position.updateMany({
        where: { symbol: position.symbol, side: position.side },
        data: { markPrice: position.markPrice, unrealizedPnl: position.unrealizedPnl, leverage: position.leverage, marginMode: position.marginMode, ...(position.liquidationPrice ? { liquidationPrice: position.liquidationPrice } : { liquidationPrice: null }) },
      });
    }
    return { positions: mapped };
  } finally {
    await adapter.disconnect().catch(() => undefined);
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