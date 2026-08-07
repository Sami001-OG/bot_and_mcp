import { prisma, type Prisma, type ExchangeAccount } from '@platform/database';
import { ExchangeError, type MarketInfo } from '@platform/exchange-core';
import { connectAccount } from './orders.js';

export async function listExchangeMarkets(account: ExchangeAccount, quote?: string): Promise<MarketInfo[]> {
  const { adapter } = await connectAccount(account);
  try {
    const markets = await adapter.getMarkets();
    const filtered = quote ? markets.filter((market) => market.quote.toUpperCase() === quote.toUpperCase()) : markets;
    return filtered.sort((a, b) => a.symbol.localeCompare(b.symbol));
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

export async function portfolioSummary(workspaceId: string) {
  const accounts = await prisma.exchangeAccount.findMany({ where: { workspaceId } });
  const totals: Record<string, { free: string; locked: string }> = {};
  const accountSummaries = await Promise.all(
    accounts.map(async (account) => {
      try {
        const { adapter, connection } = await connectAccount(account);
        try {
          const [balances, positions] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
          for (const balance of balances) {
            totals[balance.asset] = {
              free: String(Number(totals[balance.asset]?.free ?? 0) + Number(balance.free)),
              locked: String(Number(totals[balance.asset]?.locked ?? 0) + Number(balance.locked))
            };
          }
          const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
          return { accountId: account.id, exchange: account.exchange, marketType: account.marketType, label: account.label, status: 'connected', serverTime: connection.serverTime, balances, positions, unrealizedPnl: String(unrealizedPnl) };
        } finally {
          await adapter.disconnect().catch(() => undefined);
        }
      } catch (error) {
        return { accountId: account.id, exchange: account.exchange, marketType: account.marketType, label: account.label, status: 'unreachable', error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error) };
      }
    })
  );
  const orderCount = await prisma.orderIntent.count({ where: { workspaceId } });
  return { totalValue: 'N/A (spot balances aggregated)', balances: Object.entries(totals).map(([asset, value]) => ({ asset, ...value })), accounts: accountSummaries, totalOrderCount: orderCount, generatedAt: new Date().toISOString() };
}

export async function portfolioPositions(workspaceId: string) {
  const accounts = await prisma.exchangeAccount.findMany({ where: { workspaceId } });
  return Promise.all(
    accounts.map(async (account) => {
      try {
        const { adapter } = await connectAccount(account);
        try {
          const positions = await adapter.getPositions();
          return { accountId: account.id, label: account.label, status: 'connected', positions };
        } finally {
          await adapter.disconnect().catch(() => undefined);
        }
      } catch (error) {
        return { accountId: account.id, label: account.label, status: 'unreachable', error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error) };
      }
    })
  );
}

export async function listWorkspaceOrders(workspaceId: string, take = 100): Promise<Prisma.OrderIntentGetPayload<{ include: { executions: true; exchangeAccount: { select: { exchange: true; label: true } } } }>[]> {
  return prisma.orderIntent.findMany({ where: { workspaceId }, include: { executions: true, exchangeAccount: { select: { exchange: true, label: true } } }, orderBy: { createdAt: 'desc' }, take });
}
