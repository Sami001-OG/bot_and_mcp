import { z } from 'zod';
import type { ExchangeId, OrderRequest } from '@platform/contracts';
import { prisma, type ExchangeAccount, type McpClient } from '@platform/database';
import { ExchangeError, type ExchangeAdapter } from '@platform/exchange-core';
import { cancelOrderCommand, closeAllCommand, connectAccount, createBot, listExchangeMarkets, listLedgerPositions, listWorkspaceOrders, loadPolicy, placeOrder, realizedPnlInWindow, setBotStatus } from '@platform/commands';
import { McpToolError, accountAllowed, leverageAllowed, symbolAllowed, toolAllowed } from './grant.js';

export type ToolContext = { client: McpClient; workspaceId: string; correlationId: string };

export type ToolDeps = {
  enqueueExecute: (orderId: string) => Promise<void>;
  enqueueCancel: (orderId: string) => Promise<void>;
  enqueueCloseAll: (exchangeAccountId: string) => Promise<void>;
};

export type ToolSpec = {
  name: string;
  description: string;
  schema: Record<string, z.ZodType>;
  handler: (ctx: ToolContext, args: Record<string, unknown>, deps: ToolDeps) => Promise<Record<string, unknown>>;
};

async function grantedAccounts(ctx: ToolContext): Promise<ExchangeAccount[]> {
  const accounts = await prisma.exchangeAccount.findMany({ where: { workspaceId: ctx.workspaceId } });
  return accounts.filter((account) => accountAllowed(ctx.client, account.id));
}

async function resolveAccount(ctx: ToolContext, accountId: string): Promise<ExchangeAccount> {
  const account = await prisma.exchangeAccount.findFirst({ where: { id: accountId, workspaceId: ctx.workspaceId } });
  if (!account) throw new McpToolError('ACCOUNT_NOT_FOUND', 'Exchange account not found', 404);
  if (!accountAllowed(ctx.client, account.id)) throw new McpToolError('ACCOUNT_NOT_ALLOWED', 'Exchange account is not allowed by this grant');
  return account;
}

async function withAccount<T>(account: ExchangeAccount, fn: (adapter: ExchangeAdapter) => Promise<T>): Promise<T> {
  const { adapter } = await connectAccount(account);
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
      id: result.id,
      state: result.state,
      risk: result.risk,
      marketPrice: result.marketPrice,
      ...(result.sized ? { sized: result.sized } : {}),
      queuedAt: result.queuedAt,
    };
  }
  return { accepted: false, state: result.state, id: result.id, duplicate: true };
}

export const toolSpecs: ToolSpec[] = [
  {
    name: 'getPortfolio',
    description: 'Live balances and positions across the granted exchange accounts',
    schema: {},
    async handler(ctx) {
      const accounts = await grantedAccounts(ctx);
      const totals: Record<string, { free: string; locked: string }> = {};
      const summaries = [];
      let unrealizedPnl = 0;
      for (const account of accounts) {
        try {
          const { balances, positions } = await withAccount(account, async (adapter) => {
            const [b, p] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
            return { balances: b, positions: p };
          });
          for (const balance of balances) {
            totals[balance.asset] = {
              free: String(Number(totals[balance.asset]?.free ?? 0) + Number(balance.free)),
              locked: String(Number(totals[balance.asset]?.locked ?? 0) + Number(balance.locked)),
            };
          }
          unrealizedPnl += positions.reduce((sum, position) => sum + Number(position.unrealizedPnl), 0);
          summaries.push({ accountId: account.id, exchange: account.exchange, marketType: account.marketType, label: account.label, balances, positions });
        } catch (error) {
          summaries.push({ accountId: account.id, exchange: account.exchange, marketType: account.marketType, label: account.label, unreachable: error instanceof ExchangeError ? error.code : error instanceof Error ? error.message : String(error) });
        }
      }
      return { workspaceId: ctx.workspaceId, accounts: summaries, balances: Object.entries(totals).map(([asset, value]) => ({ asset, ...value })), unrealizedPnl: String(unrealizedPnl), generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getBalance',
    description: 'Current balances for the granted exchange accounts',
    schema: { accountId: z.string().optional() },
    async handler(ctx, args) {
      const accounts = args.accountId ? [await resolveAccount(ctx, String(args.accountId))] : await grantedAccounts(ctx);
      const rows = [];
      for (const account of accounts) {
        const balances = await withAccount(account, (adapter) => adapter.getBalance());
        rows.push({ accountId: account.id, exchange: account.exchange, marketType: account.marketType, balances });
      }
      return { accounts: rows, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getPositions',
    description: 'Open positions (futures/derivatives) for the granted exchange accounts',
    schema: { accountId: z.string().optional(), symbol: z.string().optional() },
    async handler(ctx, args) {
      const accounts = args.accountId ? [await resolveAccount(ctx, String(args.accountId))] : await grantedAccounts(ctx);
      const rows = [];
      for (const account of accounts) {
        const positions = await withAccount(account, (adapter) => adapter.getPositions());
        const filtered = args.symbol ? positions.filter((position) => position.symbol.toUpperCase() === String(args.symbol).toUpperCase()) : positions;
        rows.push({ accountId: account.id, exchange: account.exchange, marketType: account.marketType, positions: filtered });
      }
      return { accounts: rows, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getOrders',
    description: 'Open orders on the exchange plus the most recent persisted order intents for the granted accounts',
    schema: { accountId: z.string().optional(), symbol: z.string().optional(), recent: z.number().int().min(1).max(100).optional() },
    async handler(ctx, args) {
      const accounts = args.accountId ? [await resolveAccount(ctx, String(args.accountId))] : await grantedAccounts(ctx);
      const symbol = args.symbol ? String(args.symbol).toUpperCase() : undefined;
      const open = [];
      for (const account of accounts) {
        const orders = await withAccount(account, (adapter) => adapter.getOrders(symbol));
        open.push({ accountId: account.id, exchange: account.exchange, orders });
      }
      const intents = await listWorkspaceOrders(ctx.workspaceId, Number(args.recent) || 25);
      const recent = intents.filter((order) => accountAllowed(ctx.client, order.exchangeAccountId) && (!args.accountId || order.exchangeAccountId === String(args.accountId)));
      return {
        open,
        recent: recent.map((order) => ({ id: order.id, exchangeAccountId: order.exchangeAccountId, exchange: order.exchangeAccount.exchange, symbol: order.symbol, side: order.side, positionSide: order.positionSide, type: order.orderType, quantity: order.quantity.toString(), state: order.state, createdAt: order.createdAt.toISOString() })),
        generatedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'getMarketData',
    description: 'Current price and tradeable symbol metadata for a requested instrument on the granted accounts',
    schema: { symbol: z.string().min(3).max(40), accountId: z.string().optional() },
    async handler(ctx, args) {
      const symbol = String(args.symbol).toUpperCase();
      if (!symbolAllowed(ctx.client, symbol)) throw new McpToolError('SYMBOL_NOT_ALLOWED', `Symbol ${symbol} is not allowed by this grant`);
      const accounts = args.accountId ? [await resolveAccount(ctx, String(args.accountId))] : await grantedAccounts(ctx);
      if (accounts.length === 0) throw new McpToolError('NO_ACCOUNTS', 'No granted exchange accounts');
      const rows = [];
      for (const account of accounts) {
        const price = await withAccount(account, (adapter) => adapter.getPrice(symbol));
        const markets = await listExchangeMarkets(account);
        const market = markets.find((candidate) => candidate.symbol.toUpperCase() === symbol) ?? markets.find((candidate) => candidate.base.toUpperCase() === symbol.split('/')[0]);
        const minNotionalUsd = account.marketType === 'SPOT' || account.marketType === 'MARGIN' ? '5' : '10';
        rows.push({ accountId: account.id, exchange: account.exchange, marketType: account.marketType, symbol: market?.symbol ?? symbol, base: market?.base ?? symbol.split('/')[0], quote: market?.quote ?? symbol.split('/')[1]?.split(':')[0] ?? 'USDT', price, minNotionalUsd, active: market?.active ?? true });
      }
      return { symbols: rows, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getMarkets',
    description: 'Tradeable markets available on the granted accounts, optionally filtered by quote currency',
    schema: { quote: z.string().optional() },
    async handler(ctx, args) {
      const accounts = await grantedAccounts(ctx);
      const quote = args.quote ? String(args.quote).toUpperCase() : undefined;
      const seen = new Set<string>();
      const symbols = [];
      for (const account of accounts) {
        const markets = await listExchangeMarkets(account, quote);
        for (const market of markets) {
          if (seen.has(market.symbol)) continue;
          seen.add(market.symbol);
          symbols.push({ ...market, exchangeAccountId: account.id, exchange: account.exchange });
        }
      }
      return { count: symbols.length, quote: quote ?? '*', symbols, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getOHLCV',
    description: 'Recent candlestick history for a symbol to inform trade decisions',
    schema: { symbol: z.string().min(3).max(40), timeframe: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    async handler(ctx, args) {
      const symbol = String(args.symbol).toUpperCase();
      if (!symbolAllowed(ctx.client, symbol)) throw new McpToolError('SYMBOL_NOT_ALLOWED', `Symbol ${symbol} is not allowed by this grant`);
      const accounts = await grantedAccounts(ctx);
      const account = accounts[0];
      if (!account) throw new McpToolError('NO_ACCOUNTS', 'No granted exchange accounts');
      const candles = await withAccount(account, (adapter) => adapter.getOHLCV(symbol, String(args.timeframe ?? '1h'), Number(args.limit) || 100));
      return { symbol, timeframe: String(args.timeframe ?? '1h'), accountId: account.id, candles, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getFundingRate',
    description: 'Current funding rate for a perpetual symbol',
    schema: { symbol: z.string().min(3).max(40) },
    async handler(ctx, args) {
      const symbol = String(args.symbol).toUpperCase();
      if (!symbolAllowed(ctx.client, symbol)) throw new McpToolError('SYMBOL_NOT_ALLOWED', `Symbol ${symbol} is not allowed by this grant`);
      const accounts = await grantedAccounts(ctx);
      const account = accounts[0];
      if (!account) throw new McpToolError('NO_ACCOUNTS', 'No granted exchange accounts');
      const fundingRate = await withAccount(account, (adapter) => adapter.getFundingRate(symbol));
      return { symbol, accountId: account.id, fundingRate, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getOpenInterest',
    description: 'Open interest for a perpetual symbol',
    schema: { symbol: z.string().min(3).max(40) },
    async handler(ctx, args) {
      const symbol = String(args.symbol).toUpperCase();
      if (!symbolAllowed(ctx.client, symbol)) throw new McpToolError('SYMBOL_NOT_ALLOWED', `Symbol ${symbol} is not allowed by this grant`);
      const accounts = await grantedAccounts(ctx);
      const account = accounts[0];
      if (!account) throw new McpToolError('NO_ACCOUNTS', 'No granted exchange accounts');
      const openInterest = await withAccount(account, (adapter) => adapter.getOpenInterest(symbol));
      return { symbol, accountId: account.id, openInterest, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getRiskMetrics',
    description: 'Evaluated risk policy, balances, exposure, position count and 24h realized PnL',
    schema: {},
    async handler(ctx) {
      const policy = await loadPolicy(ctx.workspaceId);
      const accounts = await grantedAccounts(ctx);
      let equityUsd = 0;
      let openPositions = 0;
      let exposureUsd = 0;
      for (const account of accounts) {
        try {
          const { balances, positions } = await withAccount(account, async (adapter) => {
            const [b, p] = await Promise.all([adapter.getBalance(), adapter.getPositions()]);
            return { balances: b, positions: p };
          });
          equityUsd += Number(balances.find((balance) => balance.asset.toUpperCase() === 'USDT')?.free ?? '0');
          openPositions += positions.length;
          exposureUsd += positions.reduce((sum, position) => sum + Number(position.quantity) * Number(position.markPrice), 0);
        } catch {
          // account unreachable — skip
        }
      }
      const realized = await realizedPnlInWindow(ctx.workspaceId, new Date(Date.now() - 24 * 60 * 60 * 1000));
      const realized24h = realized.reduce((sum, row) => sum + Number(row.realizedPnl), 0);
      return { policy, equityUsd: String(equityUsd), openPositions, exposureUsd: String(exposureUsd), realizedPnl24h: String(realized24h), generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getPerformance',
    description: 'Realized PnL by symbol and live ledger positions over a trailing window',
    schema: { sinceDays: z.number().int().min(1).max(365).optional() },
    async handler(ctx, args) {
      const since = new Date(Date.now() - Number(args.sinceDays ?? 7) * 24 * 60 * 60 * 1000);
      const realized = await realizedPnlInWindow(ctx.workspaceId, since);
      const positions = (await listLedgerPositions(ctx.workspaceId)).filter((position) => accountAllowed(ctx.client, position.accountId));
      return { since: since.toISOString(), realized, positions, generatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'getTradeHistory',
    description: 'Recent order and execution history including fees for the granted accounts',
    schema: { accountId: z.string().optional(), take: z.number().int().min(1).max(100).optional() },
    async handler(ctx, args) {
      const orders = await listWorkspaceOrders(ctx.workspaceId, Number(args.take) || 50);
      const filtered = orders.filter((order) => accountAllowed(ctx.client, order.exchangeAccountId) && (!args.accountId || order.exchangeAccountId === String(args.accountId)));
      return {
        orders: filtered.map((order) => ({
          id: order.id,
          exchangeAccountId: order.exchangeAccountId,
          exchange: order.exchangeAccount.exchange,
          label: order.exchangeAccount.label,
          symbol: order.symbol,
          side: order.side,
          state: order.state,
          quantity: order.quantity.toString(),
          price: order.price?.toString(),
          createdAt: order.createdAt.toISOString(),
          executions: order.executions.map((execution) => ({ exchangeExecutionId: execution.exchangeExecutionId, quantity: execution.quantity.toString(), price: execution.price.toString(), fee: execution.fee.toString(), feeAsset: execution.feeAsset, executedAt: execution.executedAt.toISOString() })),
        })),
        generatedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'placeOrder',
    description: 'Place a live order through the workspace risk engine and execution queue for a granted account',
    schema: {
      exchangeAccountId: z.string(),
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
      clientOrderId: z.string().min(8).max(64).optional(),
      idempotencyKey: z.string().min(16).max(128).optional(),
    },
    async handler(ctx, args, deps) {
      const account = await resolveAccount(ctx, String(args.exchangeAccountId));
      const symbol = String(args.symbol).toUpperCase();
      if (!symbolAllowed(ctx.client, symbol)) throw new McpToolError('SYMBOL_NOT_ALLOWED', `Symbol ${symbol} is not allowed by this grant`);
      const leverage = args.leverage === undefined ? 1 : Number(args.leverage);
      if (!leverageAllowed(ctx.client, leverage)) throw new McpToolError('LEVERAGE_EXCEEDED', `Leverage ${leverage} exceeds the grant limit of ${ctx.client.maxLeverage}`);
      const request: OrderRequest = {
        exchangeAccountId: account.id,
        exchange: account.exchange.toLowerCase() as ExchangeId,
        marketType: account.marketType,
        symbol,
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
        clientOrderId: args.clientOrderId !== undefined ? String(args.clientOrderId) : `mcp-ord-${ctx.client.id.slice(0, 6)}-${ctx.correlationId.slice(0, 12)}`,
        idempotencyKey: args.idempotencyKey !== undefined ? String(args.idempotencyKey) : `mcp:${ctx.client.id}:ord:${ctx.correlationId}`,
      };
      const result = await placeOrder({
        workspaceId: ctx.workspaceId,
        request,
        enqueue: (orderId) => deps.enqueueExecute(orderId),
        ...(args.reduceOnly === true ? {} : { maxNotionalUsd: ctx.client.maxNotional.toString() }),
      });
      return { placement: serializePlaceResult(result) };
    },
  },
  {
    name: 'cancelOrder',
    description: 'Cancel an open order',
    schema: { orderId: z.string() },
    async handler(ctx, args, deps) {
      const orderId = String(args.orderId);
      const order = await prisma.orderIntent.findFirst({ where: { id: orderId, workspaceId: ctx.workspaceId } });
      if (!order) throw new McpToolError('ORDER_NOT_FOUND', 'Order not found', 404);
      if (!accountAllowed(ctx.client, order.exchangeAccountId)) throw new McpToolError('ACCOUNT_NOT_ALLOWED', 'Order belongs to an exchange account not allowed by this grant');
      return await cancelOrderCommand({ workspaceId: ctx.workspaceId, orderId, enqueue: deps.enqueueCancel });
    },
  },
  {
    name: 'closePosition',
    description: 'Close an open position for a granted account and symbol using a reduce-only market order through the risk engine',
    schema: { exchangeAccountId: z.string(), symbol: z.string().min(3).max(40) },
    async handler(ctx, args, deps) {
      const account = await resolveAccount(ctx, String(args.exchangeAccountId));
      const symbol = String(args.symbol).toUpperCase();
      if (!symbolAllowed(ctx.client, symbol)) throw new McpToolError('SYMBOL_NOT_ALLOWED', `Symbol ${symbol} is not allowed by this grant`);
      const position = await withAccount(account, async (adapter) => (await adapter.getPositions()).find((candidate) => candidate.symbol.toUpperCase() === symbol));
      if (!position || Number(position.quantity) <= 0) return { ok: true, closed: false, reason: `No open position for ${symbol} on account ${account.id}` };
      const request: OrderRequest = {
        exchangeAccountId: account.id,
        exchange: account.exchange.toLowerCase() as ExchangeId,
        marketType: account.marketType,
        symbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: position.side,
        type: 'MARKET',
        quantity: position.quantity,
        reduceOnly: true,
        postOnly: false,
        timeInForce: 'GTC' as const,
        clientOrderId: `mcp-cls-${ctx.client.id.slice(0, 6)}-${ctx.correlationId.slice(0, 12)}`,
        idempotencyKey: `mcp:${ctx.client.id}:cls:${ctx.correlationId}`,
      };
      const result = await placeOrder({ workspaceId: ctx.workspaceId, request, enqueue: (orderId) => deps.enqueueExecute(orderId) });
      return { ok: true, closed: true, position: { symbol, side: position.side, quantity: position.quantity, entryPrice: position.entryPrice }, placement: serializePlaceResult(result) };
    },
  },
  {
    name: 'closeAll',
    description: 'Liquidate all open positions on granted exchange account(s)',
    schema: { exchangeAccountId: z.string().optional() },
    async handler(ctx, args, deps) {
      if (args.exchangeAccountId) {
        const account = await resolveAccount(ctx, String(args.exchangeAccountId));
        return await closeAllCommand({ workspaceId: ctx.workspaceId, exchangeAccountId: account.id, enqueue: deps.enqueueCloseAll });
      }
      const accounts = await grantedAccounts(ctx);
      if (accounts.length === 0) throw new McpToolError('NO_ACCOUNTS', 'No granted exchange accounts');
      for (const account of accounts) await deps.enqueueCloseAll(account.id);
      return { ok: true, operation: 'CLOSE_ALL_POSITIONS', exchangeAccountIds: accounts.map((account) => account.id), queuedAt: new Date().toISOString() };
    },
  },
  {
    name: 'changeLeverage',
    description: 'Set leverage for a futures/derivatives instrument on a granted account',
    schema: { exchangeAccountId: z.string(), symbol: z.string().min(3).max(40), leverage: z.number().int().min(1).max(200) },
    async handler(ctx, args) {
      const account = await resolveAccount(ctx, String(args.exchangeAccountId));
      const symbol = String(args.symbol).toUpperCase();
      if (!symbolAllowed(ctx.client, symbol)) throw new McpToolError('SYMBOL_NOT_ALLOWED', `Symbol ${symbol} is not allowed by this grant`);
      const leverage = Number(args.leverage);
      if (!leverageAllowed(ctx.client, leverage)) throw new McpToolError('LEVERAGE_EXCEEDED', `Leverage ${leverage} exceeds the grant limit of ${ctx.client.maxLeverage}`);
      const result = await withAccount(account, (adapter) => adapter.setLeverage(symbol, leverage));
      return { ok: true, symbol, leverage: result.leverage, accountId: account.id, updatedAt: new Date().toISOString() };
    },
  },
  {
    name: 'createBot',
    description: 'Create a webhook bot on a granted exchange account with the given config',
    schema: { name: z.string().min(1).max(120), exchangeAccountId: z.string(), config: z.unknown() },
    async handler(ctx, args) {
      const account = await resolveAccount(ctx, String(args.exchangeAccountId));
      const bot = await createBot({
        workspaceId: ctx.workspaceId,
        userId: ctx.client.id,
        name: String(args.name),
        exchangeAccountId: account.id,
        config: args.config,
      });
      return { ok: true, botId: bot.id, name: bot.name, status: bot.status, activeVersion: bot.activeVersion };
    },
  },
  {
    name: 'resumeBot',
    description: 'Activate a paused webhook bot',
    schema: { botId: z.string() },
    async handler(ctx, args) {
      const bot = await prisma.bot.findFirst({ where: { id: String(args.botId), workspaceId: ctx.workspaceId } });
      if (!bot) throw new McpToolError('BOT_NOT_FOUND', 'Bot not found', 404);
      if (!accountAllowed(ctx.client, bot.exchangeAccountId)) throw new McpToolError('ACCOUNT_NOT_ALLOWED', 'Bot belongs to an exchange account not allowed by this grant');
      return await setBotStatus({ workspaceId: ctx.workspaceId, botId: bot.id, status: 'ACTIVE' });
    },
  },
  {
    name: 'pauseBot',
    description: 'Pause a running webhook bot',
    schema: { botId: z.string() },
    async handler(ctx, args) {
      const bot = await prisma.bot.findFirst({ where: { id: String(args.botId), workspaceId: ctx.workspaceId } });
      if (!bot) throw new McpToolError('BOT_NOT_FOUND', 'Bot not found', 404);
      if (!accountAllowed(ctx.client, bot.exchangeAccountId)) throw new McpToolError('ACCOUNT_NOT_ALLOWED', 'Bot belongs to an exchange account not allowed by this grant');
      return await setBotStatus({ workspaceId: ctx.workspaceId, botId: bot.id, status: 'PAUSED' });
    },
  },
  {
    name: 'deleteBot',
    description: 'Soft-delete a webhook bot by stopping it (hard delete is not supported)',
    schema: { botId: z.string() },
    async handler(ctx, args) {
      const bot = await prisma.bot.findFirst({ where: { id: String(args.botId), workspaceId: ctx.workspaceId } });
      if (!bot) throw new McpToolError('BOT_NOT_FOUND', 'Bot not found', 404);
      if (!accountAllowed(ctx.client, bot.exchangeAccountId)) throw new McpToolError('ACCOUNT_NOT_ALLOWED', 'Bot belongs to an exchange account not allowed by this grant');
      await setBotStatus({ workspaceId: ctx.workspaceId, botId: bot.id, status: 'STOPPED' });
      return { ok: true, botId: bot.id, status: 'STOPPED', note: 'Hard delete is not supported; the bot has been stopped.' };
    },
  },
];

export function runTool(name: string, ctx: ToolContext, args: Record<string, unknown>, deps: ToolDeps): Promise<Record<string, unknown>> {
  const spec = toolSpecs.find((candidate) => candidate.name === name);
  if (!spec) throw new McpToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`, 404);
  if (!toolAllowed(ctx.client, name)) throw new McpToolError('TOOL_NOT_ALLOWED', `Tool ${name} is not granted to this MCP client`);
  return spec.handler(ctx, args, deps);
}