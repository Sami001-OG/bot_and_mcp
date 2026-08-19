import { prisma, type ExchangeAccount } from '@platform/database';
import { decryptSecret, encryptSecret } from '@platform/security';
import { CommandError } from './errors.js';
import { deleteBotsByIds } from './bots.js';

export type ExchangeAccountPublic = {
  id: string;
  exchange: string;
  marketType: string;
  label: string | null;
  isPrimary: boolean;
  testnet: boolean;
  keyPreview: string;
  botCount: number;
  createdAt: Date;
  updatedAt: Date;
};

const SUPPORTED_EXCHANGES = ['bybit'] as const;

function toPublic(account: ExchangeAccount, botCount = 0): ExchangeAccountPublic {
  return {
    id: account.id,
    exchange: account.exchange,
    marketType: account.marketType,
    label: account.label,
    isPrimary: account.isPrimary,
    testnet: account.testnet === true,
    keyPreview: `${account.apiKey.slice(0, 4)}****${account.apiKey.slice(-4)}`,
    botCount,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export async function listExchangeAccounts(): Promise<ExchangeAccountPublic[]> {
  const accounts = await prisma.exchangeAccount.findMany({ include: { _count: { select: { bots: true } } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }] });
  return accounts.map((account) => toPublic(account, account._count.bots));
}

export async function createExchangeAccount(input: { exchange: string; marketType: string; label?: string; apiKey: string; secret: string; testnet?: boolean }): Promise<ExchangeAccountPublic> {
  const exchange = input.exchange.trim().toLowerCase();
  if (!(SUPPORTED_EXCHANGES as readonly string[]).includes(exchange)) {
    throw new CommandError(400, 'EXCHANGE_NOT_SUPPORTED', `Exchange not supported. Supported exchanges: ${SUPPORTED_EXCHANGES.join(', ')}`);
  }
  const marketType = input.marketType.trim().toUpperCase();
  const apiKey = input.apiKey.trim();
  const secret = input.secret.trim();
  if (!apiKey || !secret) throw new CommandError(400, 'CREDENTIAL_REQUIRED', 'API key and secret are required');
  if (!/^[A-Z_]+$/.test(marketType)) throw new CommandError(400, 'VALIDATION_ERROR', 'marketType must be an uppercase exchange market type');
  const existingCount = await prisma.exchangeAccount.count({});
  const account = await prisma.exchangeAccount.create({
    data: {
      exchange,
      marketType,
      label: input.label?.trim() || null,
      apiKey,
      apiSecret: encryptSecret(secret),
      testnet: input.testnet === true,
      isPrimary: existingCount === 0,
    },
  });
  return toPublic(account);
}

export async function deleteExchangeAccount(id: string, force = false): Promise<{ removedBots: number }> {
  const account = await prisma.exchangeAccount.findUnique({ where: { id } });
  if (!account) throw new CommandError(404, 'ACCOUNT_NOT_FOUND', 'Exchange account not found');
  const botCount = await prisma.bot.count({ where: { exchangeAccountId: id } });
  if (botCount > 0 && !force) throw new CommandError(409, 'ACCOUNT_IN_USE', `Cannot delete: ${botCount} bot(s) use this account. Delete the bots first or force the removal.`);
  let removedBots = 0;
  if (botCount > 0) {
    const bots = await prisma.bot.findMany({ where: { exchangeAccountId: id }, select: { id: true } });
    removedBots = (await deleteBotsByIds(bots.map((bot) => bot.id))).deleted;
  }
  await prisma.exchangeAccount.delete({ where: { id } });
  const remaining = await prisma.exchangeAccount.findFirst({ orderBy: { createdAt: 'asc' } });
  if (remaining && !remaining.isPrimary) await prisma.exchangeAccount.update({ where: { id: remaining.id }, data: { isPrimary: true } });
  return { removedBots };
}

export async function setPrimaryAccount(id: string): Promise<ExchangeAccountPublic> {
  const account = await prisma.exchangeAccount.findUnique({ where: { id } });
  if (!account) throw new CommandError(404, 'ACCOUNT_NOT_FOUND', 'Exchange account not found');
  await prisma.exchangeAccount.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
  const updated = await prisma.exchangeAccount.update({ where: { id }, data: { isPrimary: true } });
  return toPublic(updated);
}

export type DecryptedAccount = { account: ExchangeAccount; exchange: string; marketType: string; apiKey: string; secret: string };

export async function getAccountSecret(id: string): Promise<DecryptedAccount> {
  const account = await prisma.exchangeAccount.findUnique({ where: { id } });
  if (!account) throw new CommandError(404, 'ACCOUNT_NOT_FOUND', 'Exchange account not found');
  return { account, exchange: account.exchange, marketType: account.marketType, apiKey: account.apiKey, secret: decryptSecret(account.apiSecret) };
}

export async function getPrimaryAccount(): Promise<DecryptedAccount> {
  const account = await prisma.exchangeAccount.findFirst({ where: { isPrimary: true } });
  if (account) return getAccountSecret(account.id);
  const first = await prisma.exchangeAccount.findFirst({ orderBy: { createdAt: 'asc' } });
  if (first) return getAccountSecret(first.id);
  throw new CommandError(404, 'NO_ACCOUNT', 'No exchange account configured. Add your exchange API credentials first.');
}