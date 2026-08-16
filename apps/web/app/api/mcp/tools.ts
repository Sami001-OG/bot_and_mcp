import { z } from 'zod';
import type { ExchangeId, OrderRequest } from '@platform/contracts';
import { type ExchangeAdapter } from '@platform/exchange-core';
import { connectToAccount, getAccountConfig, listExchangeAccounts, listExchangeMarkets, listLedgerPositions, listOrders, loadPolicy, placeOrder } from '@platform/commands';
import { cancelOrderCommand, closeAllNow, createBot, realizedPnlInWindow, setBotStatus } from '@platform/commands';
import { prisma } from '@platform/database';
import { McpToolError } from './mcp-error';

export type ToolSpec = {
  name: string;
  description: string;
  schema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

async function withAccount<T>(fn: (adapter: ExchangeAdapter) => Promise<T>): Promise<T> {
  const { adapter } = await connectToAccount();
  try {
    return await fn(adapter);
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

function serializePlaceResult(result: Awaited<ReturnType<typeof placeOrder>>): Record<string, unknown> {
  if (result.accepted) {
    return {
      accepted: true,
      id: result.order.id,
      state: result.order.state,
      symbol: result.order.symbol,
      side: result.order.side,
      quantity: result.order.quantity,
      ...(result.marketPrice ? { marketPrice: result.marketPrice } : {}),
      ...(result.sized ? { sized: result.sized } : {}),
      ...(result.execution ? { execution: result.execution } : {}),
    };
  }
  return { accepted: false, state: result.order.state, id: result.order.id, duplicate: true };
}

export const toolSpecs: ToolSpec[] = [
  {
    name: 'listAccounts',
    description: 'List configured exchange accounts (their IDs are required when creating bots)',
    schema: {},
    async handler() {
      return { accounts: await listExchangeAccounts() };
    },
  },
  {
    name: 'getPortfolio',
    description: 'Live balances and positions for the configured exchange account',
    schema: {},
    async handler() {
      const { balances, positions } = await withAccount(async (adapter) => {
        const [b, p] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
        return { balances: b, positions: p };
      });
      const totals: Record<string, { free: string; locked: string }> = {};
      for (const balance of balances) {
        totals[balance.asset] = {
          free: String(Number(totals[balance.asset]?.free ?? 0) + Number(balance.free)),
          locked: String(Number(totals[balance.asset]?.locked ?? 0) + Number(balance.locked)),
        };
      }
      const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
      const config = await getAccountConfig();
      return {
        account: { exchange: config.exchange, marketType: config.marketType, label: config.label },
        balances,
        positions,
        balancesByAsset: Object.entries(totals).map(([asset, value]) => ({ asset, ...value })),
        unrealizedPnl: String(unrealizedPnl),
        generatedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'getBalance',
    description: 'Current balances for the configured exchange account',
    schema: {},
    async handler() {
      const balances = await withAccount((adapter) => adapter.getBalance());
      return { balances, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getPositions',
    description: 'Open positions (futures/derivatives) for the configured exchange account',
    schema: { symbol: z.string().optional() },
    async handler(args) {
      const positions = await withAccount((adapter) => adapter.getPositions());
      const filtered = args.symbol ? positions.filter((position) => position.symbol.toUpperCase() === String(args.symbol).toUpperCase()) : positions;
      return { positions: filtered, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getOrders',
    description: 'Open orders on the exchange plus the most recent persisted order intents',
    schema: { symbol: z.string().optional(), recent: z.number().int().min(1).max(100).optional() },
    async handler(args) {
      const symbol = args.symbol ? String(args.symbol).toUpperCase() : undefined;
      const open = await withAccount((adapter) => adapter.getOrders(symbol));
      const intents = await listOrders(Number(args.recent) || 25);
      return {
        open,
        recent: intents.map((order) => ({ id: order.id, symbol: order.symbol, side: order.side, positionSide: order.positionSide, type: order.orderType, quantity: order.quantity, state: order.state, createdAt: order.createdAt.toISOString() })),
        generatedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'getMarketData',
    description: 'Current price and tradeable symbol metadata for a requested instrument',
    schema: { symbol: z.string().min(3).max(40) },
    async handler(args) {
      const symbol = String(args.symbol).toUpperCase();
      const price = await withAccount((adapter) => adapter.getPrice(symbol));
      const markets = await listExchangeMarkets();
      const market = markets.find((candidate) => candidate.symbol.toUpperCase() === symbol) ?? markets.find((candidate) => candidate.base.toUpperCase() === symbol.split('/')[0]);
      const config = await getAccountConfig();
      const minNotionalUsd = config.marketType === 'SPOT' || config.marketType === 'MARGIN' ? '5' : '10';
      return {
        exchange: config.exchange,
        marketType: config.marketType,
        symbol: market?.symbol ?? symbol,
        base: market?.base ?? symbol.split('/')[0],
        quote: market?.quote ?? symbol.split('/')[1]?.split(':')[0] ?? 'USDT',
        price,
        minNotionalUsd,
        active: market?.active ?? true,
        generatedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'getMarkets',
    description: 'Tradeable markets available on the exchange, optionally filtered by quote currency',
    schema: { quote: z.string().optional() },
    async handler(args) {
      const quote = args.quote ? String(args.quote).toUpperCase() : undefined;
      const symbols = await listExchangeMarkets(quote);
      return { count: symbols.length, quote: quote ?? '*', symbols, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getOHLCV',
    description: 'Recent candlestick history for a symbol to inform trade decisions',
    schema: { symbol: z.string().min(3).max(40), timeframe: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    async handler(args) {
      const symbol = String(args.symbol).toUpperCase();
      const candles = await withAccount((adapter) => adapter.getOHLCV(symbol, String(args.timeframe ?? '1h'), Number(args.limit) || 100));
      return { symbol, timeframe: String(args.timeframe ?? '1h'), candles, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getFundingRate',
    description: 'Current funding rate for a perpetual symbol',
    schema: { symbol: z.string().min(3).max(40) },
    async handler(args) {
      const symbol = String(args.symbol).toUpperCase();
      const fundingRate = await withAccount((adapter) => adapter.getFundingRate(symbol));
      return { symbol, fundingRate, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getOpenInterest',
    description: 'Open interest for a perpetual symbol',
    schema: { symbol: z.string().min(3).max(40) },
    async handler(args) {
      const symbol = String(args.symbol).toUpperCase();
      const openInterest = await withAccount((adapter) => adapter.getOpenInterest(symbol));
      return { symbol, openInterest, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getRiskMetrics',
    description: 'Evaluated risk policy, balances, exposure, position count and 24h realized PnL',
    schema: {},
    async handler() {
      const policy = await loadPolicy();
      let equityUsd = 0;
      let openPositions = 0;
      let exposureUsd = 0;
      try {
        const { balances, positions } = await withAccount(async (adapter) => {
          const [b, p] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
          return { balances: b, positions: p };
        });
        equityUsd += Number(balances.find((balance) => balance.asset.toUpperCase() === 'USDT')?.free ?? '0');
        openPositions += positions.length;
        exposureUsd += positions.reduce((sum, position) => sum + Number(position.quantity) * Number(position.markPrice), 0);
      } catch {
        // account unreachable — skip
      }
      const realized = await realizedPnlInWindow(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const realized24h = realized.reduce((sum, row) => sum + Number(row.realizedPnl), 0);
      return { policy, equityUsd: String(equityUsd), openPositions, exposureUsd: String(exposureUsd), realizedPnl24h: String(realized24h), generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getPerformance',
    description: 'Realized PnL by symbol and live ledger positions over a trailing window',
    schema: { sinceDays: z.number().int().min(1).max(365).optional() },
    async handler(args) {
      const since = new Date(Date.now() - Number(args.sinceDays ?? 7) * 24 * 60 * 60 * 1000);
      const realized = await realizedPnlInWindow(since);
      const positions = await listLedgerPositions();
      return { since: since.toISOString(), realized, positions, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getTradeHistory',
    description: 'Recent order and execution history including fees',
    schema: { take: z.number().int().min(1).max(100).optional() },
    async handler(args) {
      const orders = await listOrders(Number(args.take) || 50);
      return {
        orders: orders.map((order) => ({
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          state: order.state,
          quantity: order.quantity,
          price: order.price,
          createdAt: order.createdAt.toISOString(),
          executions: order.executions.map((execution) => ({ exchangeExecutionId: execution.exchangeExecutionId, quantity: execution.quantity, price: execution.price, fee: execution.fee, feeAsset: execution.feeAsset, executedAt: execution.executedAt.toISOString() })),
        })),
        generatedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'placeOrder',
    description: 'Place a live order through the risk engine (executed synchronously)',
    schema: {
      symbol: z.string().min(3).max(40),
      side: z.enum(['BUY', 'SELL']),
      type: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP']).default('MARKET'),
      quantity: z.string().optional(),
      allocation: z.unknown().optional(),
      price: z.string().optional(),
      stopPrice: z.string().optional(),
      reduceOnly: z.boolean().optional(),
      leverage: z.number().int().min(1).max(200).optional(),
      positionSide: z.enum(['LONG', 'SHORT', 'BOTH']).optional(),
      marginMode: z.enum(['ISOLATED', 'CROSS']).optional(),
      clientOrderId: z.string().min(8).max(64).optional(),
      idempotencyKey: z.string().min(16).max(128).optional(),
    },
    async handler(args) {
      const config = await getAccountConfig();
      const leverage = args.leverage === undefined ? 1 : Number(args.leverage);
      const request: OrderRequest = {
        exchangeAccountId: 'default',
        exchange: config.exchange.toLowerCase() as ExchangeId,
        marketType: config.marketType,
        symbol: String(args.symbol).toUpperCase(),
        side: args.side as 'BUY' | 'SELL',
        positionSide: (args.positionSide ?? 'BOTH') as OrderRequest['positionSide'],
        type: args.type as OrderRequest['type'],
        ...(args.quantity !== undefined ? { quantity: String(args.quantity) } : {}),
        ...(args.allocation !== undefined ? { allocation: args.allocation as OrderRequest['allocation'] } : {}),
        ...(args.price !== undefined ? { price: String(args.price) } : {}),
        ...(args.stopPrice !== undefined ? { stopPrice: String(args.stopPrice) } : {}),
        reduceOnly: Boolean(args.reduceOnly),
        postOnly: false,
        timeInForce: 'GTC' as const,
        ...(leverage > 1 ? { leverage } : {}),
        ...(args.marginMode !== undefined ? { marginMode: args.marginMode as OrderRequest['marginMode'] } : {}),
        clientOrderId: args.clientOrderId !== undefined ? String(args.clientOrderId) : `mcp-ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        idempotencyKey: args.idempotencyKey !== undefined ? String(args.idempotencyKey) : `mcp:ord:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`,
      };
      const result = await placeOrder({ request });
      return { placement: serializePlaceResult(result) };
    },
  },
  {
    name: 'cancelOrder',
    description: 'Cancel an open order',
    schema: { orderId: z.string() },
    async handler(args) {
      const orderId = String(args.orderId);
      const order = await prisma.orderIntent.findUnique({ where: { id: orderId } });
      if (!order) throw new McpToolError('ORDER_NOT_FOUND', 'Order not found', 404);
      return await cancelOrderCommand(orderId);
    },
  },
  {
    name: 'closePosition',
    description: 'Close an open position for a symbol using a reduce-only market order through the risk engine',
    schema: { symbol: z.string().min(3).max(40) },
    async handler(args) {
      const symbol = String(args.symbol).toUpperCase();
      const position = await withAccount(async (adapter) => (await adapter.getPositions()).find((candidate) => candidate.symbol.toUpperCase() === symbol));
      if (!position || Number(position.quantity) <= 0) return { ok: true, closed: false, reason: `No open position for ${symbol}` };
      const config = await getAccountConfig();
      const request: OrderRequest = {
        exchangeAccountId: 'default',
        exchange: config.exchange.toLowerCase() as ExchangeId,
        marketType: config.marketType,
        symbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: position.side,
        type: 'MARKET',
        quantity: String(position.quantity),
        reduceOnly: true,
        postOnly: false,
        timeInForce: 'GTC' as const,
        clientOrderId: `mcp-cls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        idempotencyKey: `mcp:cls:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`,
      };
      const result = await placeOrder({ request });
      return { ok: true, closed: true, position: { symbol, side: position.side, quantity: String(position.quantity), entryPrice: String(position.entryPrice) }, placement: serializePlaceResult(result) };
    },
  },
  {
    name: 'closeAll',
    description: 'Liquidate all open positions on the exchange account',
    schema: {},
    async handler() {
      return await closeAllNow();
    },
  },
  {
    name: 'changeLeverage',
    description: 'Set leverage for a futures/derivatives instrument',
    schema: { symbol: z.string().min(3).max(40), leverage: z.number().int().min(1).max(200) },
    async handler(args) {
      const symbol = String(args.symbol).toUpperCase();
      const leverage = Number(args.leverage);
      const result = await withAccount((adapter) => adapter.setLeverage(symbol, leverage));
      return { ok: true, symbol, leverage: result.leverage, updatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'createBot',
    description: 'Create a webhook bot bound to an exchange account (creates a dedicated webhook endpoint). exchangeAccountId is required.',
    schema: { name: z.string().min(1).max(120), exchangeAccountId: z.string().min(1).max(64), config: z.unknown() },
    async handler(args) {
      const result = await createBot({ name: String(args.name), exchangeAccountId: String(args.exchangeAccountId), config: args.config });
      return { ok: true, botId: result.bot.id, name: result.bot.name, status: result.bot.status, activeVersion: result.bot.activeVersion, webhookId: result.webhook.id, signingSecret: result.webhook.signingSecret };
    },
  },
  {
    name: 'resumeBot',
    description: 'Activate a paused webhook bot',
    schema: { botId: z.string() },
    async handler(args) {
      const bot = await prisma.bot.findUnique({ where: { id: String(args.botId) } });
      if (!bot) throw new McpToolError('BOT_NOT_FOUND', 'Bot not found', 404);
      return await setBotStatus({ botId: bot.id, status: 'ACTIVE' });
    },
  },
  {
    name: 'pauseBot',
    description: 'Pause a running webhook bot',
    schema: { botId: z.string() },
    async handler(args) {
      const bot = await prisma.bot.findUnique({ where: { id: String(args.botId) } });
      if (!bot) throw new McpToolError('BOT_NOT_FOUND', 'Bot not found', 404);
      return await setBotStatus({ botId: bot.id, status: 'PAUSED' });
    },
  },
  {
    name: 'deleteBot',
    description: 'Soft-delete a webhook bot by stopping it (hard delete is not supported)',
    schema: { botId: z.string() },
    async handler(args) {
      const bot = await prisma.bot.findUnique({ where: { id: String(args.botId) } });
      if (!bot) throw new McpToolError('BOT_NOT_FOUND', 'Bot not found', 404);
      await setBotStatus({ botId: bot.id, status: 'STOPPED' });
      return { ok: true, botId: bot.id, status: 'STOPPED', note: 'Hard delete is not supported; the bot has been stopped.' };
    },
  },
];

export async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const spec = toolSpecs.find((candidate) => candidate.name === name);
  if (!spec) throw new McpToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`, 404);
  return spec.handler(args);
}