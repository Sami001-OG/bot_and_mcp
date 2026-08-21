import { prisma, type Bot } from '@platform/database';
import { OrderRequestSchema, WebhookBotConfigSchema, marketTypeForSymbol, type ExchangeId, type OrderRequest, type WebhookBotConfig } from '@platform/contracts';
import { type ExchangeAdapter } from '@platform/exchange-core';
import { connectToAccount, getAccountConfig, type AccountConfig } from './account.js';
import { CommandError } from './errors.js';
import { cancelOrderCommand, closeAllNow } from './execute.js';
import { placeOrder, type PlaceOrderResult } from './orders.js';

export type BotTradeContext = {
  bot: Bot;
  config: WebhookBotConfig;
  account: AccountConfig;
};

export async function getBotTradeContext(botId: string, requireActive = true): Promise<BotTradeContext> {
  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot) throw new CommandError(404, 'BOT_NOT_FOUND', 'Bot not found');
  if (bot.type !== 'WEBHOOK') throw new CommandError(409, 'BOT_NOT_TRADABLE', 'Only webhook bots can trade');
  if (requireActive && bot.status !== 'ACTIVE') {
    throw new CommandError(409, 'BOT_NOT_TRADING', `Bot is ${bot.status}; only ACTIVE bots can trade`);
  }
  if (!bot.exchangeAccountId) throw new CommandError(409, 'BOT_NO_ACCOUNT', 'Bot has no exchange account');
  let config: WebhookBotConfig;
  try {
    config = WebhookBotConfigSchema.parse(bot.config);
  } catch {
    throw new CommandError(500, 'BOT_CONFIG_INVALID', 'Bot config failed validation');
  }
  const account = await getAccountConfig(bot.exchangeAccountId);
  return { bot, config, account };
}

function assertBotSymbol(ctx: BotTradeContext, symbol: string): void {
  const target = symbol.split(':')[0]?.toUpperCase() ?? symbol.toUpperCase();
  const matches = ctx.config.symbols.some((entry) => entry === '*' || (entry.split(':')[0]?.toUpperCase() ?? entry.toUpperCase()) === target);
  if (!matches) {
    throw new CommandError(409, 'SYMBOL_NOT_IN_BOT', `Symbol ${symbol} is not in bot symbols (${ctx.config.symbols.join(', ')})`);
  }
}

export type BotPlaceOrderArgs = {
  symbol: string;
  side: 'BUY' | 'SELL';
  type?: string;
  quantity?: string;
  allocation?: unknown;
  price?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
  leverage?: number;
  positionSide?: 'LONG' | 'SHORT' | 'BOTH';
  marginMode?: 'ISOLATED' | 'CROSS';
  clientOrderId?: string;
  idempotencyKey?: string;
};

export async function placeOrderThroughBot(botId: string, args: BotPlaceOrderArgs): Promise<PlaceOrderResult> {
  const ctx = await getBotTradeContext(botId);
  const symbol = String(args.symbol).toUpperCase();
  assertBotSymbol(ctx, symbol);
  const leverage = args.leverage === undefined ? (ctx.config.leverage ?? 1) : Number(args.leverage);
  const request: OrderRequest = {
    exchangeAccountId: ctx.account.id,
    exchange: ctx.account.exchange,
    marketType: marketTypeForSymbol(symbol),
    symbol,
    side: args.side,
    positionSide: (args.positionSide ?? 'BOTH') as OrderRequest['positionSide'],
    type: (args.type ?? 'MARKET') as OrderRequest['type'],
    ...(args.quantity !== undefined ? { quantity: String(args.quantity) } : {}),
    ...(args.allocation !== undefined ? { allocation: args.allocation as OrderRequest['allocation'] } : {}),
    ...(args.price !== undefined ? { price: String(args.price) } : {}),
    ...(args.stopPrice !== undefined ? { stopPrice: String(args.stopPrice) } : {}),
    reduceOnly: Boolean(args.reduceOnly),
    postOnly: false,
    timeInForce: 'GTC' as const,
    ...(leverage > 1 ? { leverage } : {}),
    ...(args.marginMode !== undefined ? { marginMode: args.marginMode as OrderRequest['marginMode'] } : {}),
    clientOrderId: args.clientOrderId !== undefined ? String(args.clientOrderId) : `bot-${ctx.bot.id.slice(-6)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: args.idempotencyKey !== undefined ? String(args.idempotencyKey) : `bot:ord:${ctx.bot.id.slice(-6)}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
  };
  const parsed = OrderRequestSchema.parse(request);
  return placeOrder({ request: parsed, source: { kind: 'mcp', botId: ctx.bot.id, botName: ctx.bot.name } });
}

export async function cancelOrderThroughBot(botId: string, orderId: string): Promise<{ accepted: true; orderId: string; state: string }> {
  const ctx = await getBotTradeContext(botId);
  const order = await prisma.orderIntent.findUnique({ where: { id: orderId } });
  if (!order) throw new CommandError(404, 'ORDER_NOT_FOUND', 'Order not found');
  if (order.exchangeAccountId && order.exchangeAccountId !== ctx.account.id) {
    throw new CommandError(403, 'ORDER_NOT_IN_BOT', 'Order does not belong to this bot');
  }
  return cancelOrderCommand(orderId);
}

export async function closePositionThroughBot(botId: string, symbol: string): Promise<Record<string, unknown>> {
  const ctx = await getBotTradeContext(botId);
  const normalized = String(symbol).toUpperCase();
  assertBotSymbol(ctx, normalized);
  const marketType = marketTypeForSymbol(normalized);
  let position: { symbol: string; side: 'LONG' | 'SHORT'; quantity: string; entryPrice: string } | undefined;
  const session = await connectToAccount(ctx.account.id, marketType);
  try {
    const found = (await session.adapter.getPositions()).find((entry) => entry.symbol.toUpperCase() === normalized.split(':')[0]);
    if (found) position = { symbol: found.symbol, side: found.side as 'LONG' | 'SHORT', quantity: String(found.quantity), entryPrice: String(found.entryPrice) };
  } finally {
    await session.adapter.disconnect().catch(() => undefined);
  }
  if (!position || Number(position.quantity) <= 0) return { ok: true, closed: false, reason: `No open position for ${normalized}` };
  const request: OrderRequest = {
    exchangeAccountId: ctx.account.id,
    exchange: ctx.account.exchange as ExchangeId,
    marketType,
    symbol: normalized,
    side: position.side === 'LONG' ? 'SELL' : 'BUY',
    positionSide: position.side,
    type: 'MARKET',
    quantity: position.quantity,
    reduceOnly: true,
    postOnly: false,
    timeInForce: 'GTC' as const,
    clientOrderId: `bot-cls-${ctx.bot.id.slice(-6)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `bot:cls:${ctx.bot.id.slice(-6)}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
  };
  const parsed = OrderRequestSchema.parse(request);
  const result = await placeOrder({ request: parsed, source: { kind: 'mcp', botId: ctx.bot.id, botName: ctx.bot.name } });
  return { ok: true, closed: true, position, placement: result };
}

export async function closeAllThroughBot(botId: string): Promise<Awaited<ReturnType<typeof closeAllNow>>> {
  const ctx = await getBotTradeContext(botId);
  return closeAllNow(ctx.account.id);
}

export async function changeLeverageThroughBot(botId: string, symbol: string, leverage: number): Promise<Record<string, unknown>> {
  const ctx = await getBotTradeContext(botId);
  const normalized = String(symbol).toUpperCase();
  assertBotSymbol(ctx, normalized);
  const marketType = marketTypeForSymbol(normalized);
  if (marketType === 'SPOT') throw new CommandError(400, 'LEVERAGE_UNSUPPORTED_SPOT', `Leverage is not supported on spot market ${normalized}`);
  const session = await connectToAccount(ctx.account.id, marketType);
  try {
    const result = await session.adapter.setLeverage(normalized, leverage);
    return { ok: true, symbol: normalized, leverage: result.leverage, updatedAt: new Date().toISOString() };
  } finally {
    await session.adapter.disconnect().catch(() => undefined);
  }
}

export async function withBotAccount<T>(botId: string, fn: (adapter: ExchangeAdapter) => Promise<T>): Promise<T> {
  const ctx = await getBotTradeContext(botId, false);
  const session = await connectToAccount(ctx.account.id);
  try {
    return await fn(session.adapter);
  } finally {
    await session.adapter.disconnect().catch(() => undefined);
  }
}