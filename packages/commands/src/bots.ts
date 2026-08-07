import { WebhookBotConfigSchema } from '@platform/contracts';
import { prisma, type Prisma, type Bot } from '@platform/database';
import { hashToken } from '@platform/security';
import { CommandError } from './orders.js';

export type CreateBotInput = { workspaceId: string; userId: string; name: string; exchangeAccountId: string; config: unknown };

export async function createBot(input: CreateBotInput): Promise<Bot> {
  const { workspaceId, userId, name, exchangeAccountId } = input;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { liveTradingEnabled: true } });
  if (!workspace?.liveTradingEnabled) throw new CommandError(409, 'LIVE_TRADING_DISABLED', 'Live trading is disabled for this workspace');
  const config = WebhookBotConfigSchema.parse(input.config);
  const account = await prisma.exchangeAccount.findFirst({ where: { id: exchangeAccountId, workspaceId } });
  if (!account) throw new CommandError(404, 'ACCOUNT_NOT_FOUND', 'Exchange account not found');
  if (account.credentialStatus !== 'VERIFIED') throw new CommandError(409, 'ACCOUNT_NOT_VERIFIED', 'Exchange account must be VERIFIED before attaching a bot');
  if (!account.tradingEnabled) throw new CommandError(409, 'ACCOUNT_TRADING_DISABLED', 'Trading is not enabled for this exchange account');
  const checksum = hashToken(JSON.stringify(config));
  const bot = await prisma.$transaction(async (tx) => {
    const created = await tx.bot.create({ data: { workspaceId, exchangeAccountId: account.id, name, type: 'WEBHOOK', status: 'ACTIVE', activeVersion: 1, config } });
    await tx.botVersion.create({ data: { botId: created.id, version: 1, config, checksum, createdBy: userId } });
    return created;
  });
  return bot;
}

export type UpdateBotConfigInput = { workspaceId: string; userId: string; botId: string; config: unknown };

export async function updateBotConfig(input: UpdateBotConfigInput): Promise<Bot> {
  const { workspaceId, userId, botId } = input;
  const bot = await prisma.bot.findFirst({ where: { id: botId, workspaceId } });
  if (!bot) throw new CommandError(404, 'BOT_NOT_FOUND', 'Bot not found');
  const config = WebhookBotConfigSchema.parse(input.config);
  const nextVersion = bot.activeVersion + 1;
  const checksum = hashToken(JSON.stringify(config));
  return prisma.$transaction(async (tx) => {
    await tx.botVersion.create({ data: { botId: bot.id, version: nextVersion, config, checksum, createdBy: userId } });
    return tx.bot.update({ where: { id: bot.id }, data: { config, activeVersion: nextVersion } });
  });
}

export type BotStatus = 'PAUSED' | 'ACTIVE' | 'STOPPED';

export async function setBotStatus(input: { workspaceId: string; botId: string; status: BotStatus }): Promise<{ id: string; status: BotStatus }> {
  const { workspaceId, botId, status } = input;
  const bot = await prisma.bot.findFirst({ where: { id: botId, workspaceId } });
  if (!bot) throw new CommandError(404, 'BOT_NOT_FOUND', 'Bot not found');
  if (bot.status === status) return { id: botId, status };
  await prisma.bot.update({ where: { id: botId }, data: { status } });
  return { id: botId, status };
}

export async function listBots(workspaceId: string): Promise<Prisma.BotGetPayload<{ include: { exchangeAccount: { select: { exchange: true; label: true } } } }>[]> {
  return prisma.bot.findMany({ where: { workspaceId }, include: { exchangeAccount: { select: { exchange: true, label: true } } }, orderBy: { createdAt: 'desc' } });
}

export async function getBot(workspaceId: string, botId: string): Promise<Prisma.BotGetPayload<{ include: { exchangeAccount: { select: { exchange: true; label: true; marketType: true } }; versions: { orderBy: { version: 'desc' } }; runs: { orderBy: { startedAt: 'desc' }; take: 20 } } }>> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, workspaceId },
    include: { exchangeAccount: { select: { exchange: true, label: true, marketType: true } }, versions: { orderBy: { version: 'desc' } }, runs: { orderBy: { startedAt: 'desc' }, take: 20 } }
  });
  if (!bot) throw new CommandError(404, 'BOT_NOT_FOUND', 'Bot not found');
  return bot;
}
