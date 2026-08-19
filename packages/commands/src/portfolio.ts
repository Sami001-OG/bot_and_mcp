import { prisma } from '@platform/database';
import { ExchangeError } from '@platform/exchange-core';
import { connectToAccount, getAccountConfig } from './account.js';
import { listExchangeMarkets } from './markets.js';

export { listExchangeMarkets };

export async function portfolioSummary(marketType?: string) {
  const config = await getAccountConfig();
  try {
    const { adapter, connection } = await connectToAccount(undefined, marketType as never);
    try {
      const [balances, positions] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
      const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
      const orderCount = await prisma.orderIntent.count({});
      return {
        account: { exchange: config.exchange, marketType: config.marketType, label: config.label },
        status: 'connected',
        serverTime: connection.serverTime,
        balances,
        positions,
        unrealizedPnl: String(unrealizedPnl),
        totalOrderCount: orderCount,
        generatedAt: new Date().toISOString()
      };
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
  } catch (error) {
    return {
      account: { exchange: config.exchange, marketType: config.marketType, label: config.label },
      status: 'unreachable',
      error: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error),
      generatedAt: new Date().toISOString()
    };
  }
}

export async function portfolioPositions() {
  const { adapter } = await connectToAccount();
  try {
    const positions = await adapter.getPositions();
    return { status: 'connected', positions };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

export type RawExecution = {
  id: string;
  orderIntentId: string;
  exchangeExecutionId: string;
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string | null;
  executedAt: Date;
};

export type ExecutionRow = RawExecution & { orderIntent: { symbol: string; side: string; positionSide: string; orderType: string; state: string; clientOrderId: string; source: unknown } };

export async function listOrders(take = 100): Promise<Array<{ id: string; symbol: string; side: string; positionSide: string; orderType: string; quantity: string; price: string | null; stopPrice: string | null; state: string; rejectionReason: string | null; exchangeOrderId: string | null; clientOrderId: string; reduceOnly: boolean; source: unknown; createdAt: Date; updatedAt: Date; executions: RawExecution[] }>> {
  return prisma.orderIntent.findMany({ include: { executions: true }, orderBy: { createdAt: 'desc' }, take });
}

export async function listExecutions(take = 100): Promise<Array<{ orderId: string; exchange: string; label: string; symbol: string; side: string; positionSide: string; orderType: string; state: string; clientOrderId: string; source: unknown; executionId: string; quantity: string; price: string; fee: string; feeAsset: string | null; executedAt: Date; createdAt: Date }>> {
  const config = await getAccountConfig();
  const executions = await prisma.execution.findMany({
    include: { orderIntent: { select: { symbol: true, side: true, positionSide: true, orderType: true, state: true, clientOrderId: true, source: true } } },
    orderBy: { executedAt: 'desc' },
    take,
  });
  return executions.map((execution) => ({
    orderId: execution.orderIntentId,
    exchange: config.exchange,
    label: config.label,
    symbol: execution.orderIntent.symbol,
    side: execution.orderIntent.side,
    positionSide: execution.orderIntent.positionSide,
    orderType: execution.orderIntent.orderType,
    state: execution.orderIntent.state,
    clientOrderId: execution.orderIntent.clientOrderId,
    source: execution.orderIntent.source,
    executionId: execution.id,
    quantity: execution.quantity,
    price: execution.price,
    fee: execution.fee,
    feeAsset: execution.feeAsset,
    executedAt: execution.executedAt,
    createdAt: execution.createdAt
  }));
}