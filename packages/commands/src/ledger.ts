import { Prisma, prisma, type ExchangeAccount } from '@platform/database';
import type { MarginMode, PositionSide } from '@platform/contracts';
import { computeRealizedPnl } from '@platform/trading-core';
import { connectAccount } from './orders.js';

export type LedgerPosition = { symbol: string; side: PositionSide; quantity: string; averageEntryPrice: string; markPrice: string; unrealizedPnl: string; leverage: number; liquidationPrice?: string; marginMode: MarginMode };

export async function syncPositionsFromExchange(account: ExchangeAccount): Promise<{ accountId: string; positions: LedgerPosition[] }> {
  const { adapter } = await connectAccount(account);
  try {
    const positions = await adapter.getPositions();
    const mapped: LedgerPosition[] = positions.map((position) => ({ symbol: position.symbol, side: position.side, quantity: position.quantity, averageEntryPrice: position.entryPrice, markPrice: position.markPrice, unrealizedPnl: position.unrealizedPnl, leverage: position.leverage, ...(position.liquidationPrice ? { liquidationPrice: position.liquidationPrice } : {}), marginMode: position.marginMode }));
    for (const position of mapped) {
      await prisma.position.updateMany({
        where: { exchangeAccountId: account.id, symbol: position.symbol, side: position.side },
        data: { markPrice: new Prisma.Decimal(position.markPrice), unrealizedPnl: new Prisma.Decimal(position.unrealizedPnl), leverage: position.leverage, marginMode: position.marginMode, ...(position.liquidationPrice ? { liquidationPrice: new Prisma.Decimal(position.liquidationPrice) } : { liquidationPrice: null }) },
      });
    }
    return { accountId: account.id, positions: mapped };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

export async function realizedPnlInWindow(workspaceId: string, since: Date): Promise<Array<{ symbol: string; realizedPnl: string; fills: number }>> {
  const executions = await prisma.execution.findMany({
    where: { executedAt: { gte: since }, orderIntent: { workspaceId } },
    include: { orderIntent: { select: { symbol: true, side: true } } },
    orderBy: { executedAt: 'asc' },
  });
  const bySymbol = new Map<string, Array<{ side: 'BUY' | 'SELL'; quantity: string; price: string; fee: string }>>();
  for (const execution of executions) {
    const fills = bySymbol.get(execution.orderIntent.symbol) ?? [];
    fills.push({ side: execution.orderIntent.side, quantity: execution.quantity.toString(), price: execution.price.toString(), fee: execution.fee.toString() });
    bySymbol.set(execution.orderIntent.symbol, fills);
  }
  return [...bySymbol.entries()].map(([symbol, fills]) => ({ symbol, realizedPnl: computeRealizedPnl(fills), fills: fills.length }));
}

export async function dailyRealizedPnl(workspaceId: string): Promise<string> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rows = await realizedPnlInWindow(workspaceId, today);
  return rows.reduce((sum, row) => sum.add(new Prisma.Decimal(row.realizedPnl)), new Prisma.Decimal(0)).toFixed(8);
}

export type CircuitBreaker = { ok: true } | { ok: false; reason: string; dailyPnl: string; limit: string; limitReached: boolean };

export async function checkCircuitBreaker(workspaceId: string): Promise<CircuitBreaker> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { liveTradingEnabled: true, dailyLossLimit: true } });
  if (!workspace) return { ok: false, reason: 'Workspace not found', dailyPnl: '0', limit: '0', limitReached: false };
  if (!workspace.liveTradingEnabled) return { ok: false, reason: 'Live trading is disabled for this workspace', dailyPnl: '0', limit: '0', limitReached: false };
  const dailyPnl = new Prisma.Decimal(await dailyRealizedPnl(workspaceId));
  if (workspace.dailyLossLimit !== null) {
    const limit = workspace.dailyLossLimit;
    if (dailyPnl.lte(limit.negated())) {
      return { ok: false, reason: `Daily loss limit reached (${dailyPnl.toFixed(4)} vs limit ${limit.toFixed(4)})`, dailyPnl: dailyPnl.toFixed(4), limit: limit.toFixed(4), limitReached: true };
    }
  }
  return { ok: true };
}

export async function listLedgerPositions(workspaceId: string): Promise<Array<{ accountId: string; exchange: string; marketType: string; symbol: string; side: PositionSide; quantity: string; averageEntryPrice: string; markPrice: string; unrealizedPnl: string; realizedPnl: string; leverage: number; liquidationPrice?: string; marginMode: MarginMode; updatedAt: Date }>> {
  const rows = await prisma.position.findMany({
    where: { workspaceId },
    include: { exchangeAccount: { select: { exchange: true, marketType: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((row) => ({ accountId: row.exchangeAccountId, exchange: row.exchangeAccount.exchange, marketType: row.exchangeAccount.marketType, symbol: row.symbol, side: row.side, quantity: row.quantity.toString(), averageEntryPrice: row.averageEntryPrice.toString(), markPrice: row.markPrice.toString(), unrealizedPnl: row.unrealizedPnl.toString(), realizedPnl: row.realizedPnl.toString(), leverage: row.leverage, ...(row.liquidationPrice ? { liquidationPrice: row.liquidationPrice.toString() } : {}), marginMode: row.marginMode, updatedAt: row.updatedAt }));
}
