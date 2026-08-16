import { prisma, type Settings } from '@platform/database';
import { CommandError } from './errors.js';

export type SettingsPatch = Partial<Pick<Settings, 'tradingEnabled' | 'liveTradingAcknowledgedAt' | 'dailyLossLimit' | 'equity' | 'peakEquity' | 'breakerTripped' | 'breakerReason' | 'breakerDailyPnl'>>;

export async function getSettings(): Promise<Settings> {
  const existing = await prisma.settings.findFirst({});
  if (existing) return existing;
  return prisma.settings.create({ data: {} });
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();
  return prisma.settings.update({ where: { id: current.id }, data: patch });
}

export async function requireTradingEnabled(): Promise<void> {
  const settings = await getSettings();
  if (!settings.tradingEnabled) throw new CommandError(409, 'LIVE_TRADING_DISABLED', 'Live trading is disabled');
}

export async function setTradingEnabled(enabled: boolean): Promise<{ tradingEnabled: boolean; liveTradingAcknowledgedAt: Date | null }> {
  const settings = await getSettings();
  const patched = await prisma.settings.update({
    where: { id: settings.id },
    data: { tradingEnabled: enabled, ...(enabled ? { liveTradingAcknowledgedAt: settings.liveTradingAcknowledgedAt ?? new Date() } : {}) }
  });
  return { tradingEnabled: patched.tradingEnabled, liveTradingAcknowledgedAt: patched.liveTradingAcknowledgedAt };
}

export async function setDailyLossLimit(limit: string | null): Promise<{ dailyLossLimit: string | null }> {
  const settings = await getSettings();
  const patched = await prisma.settings.update({
    where: { id: settings.id },
    data: { dailyLossLimit: limit, breakerTripped: false, breakerReason: null, breakerDailyPnl: null }
  });
  return { dailyLossLimit: patched.dailyLossLimit };
}

export async function clearCircuitBreaker(): Promise<void> {
  const settings = await getSettings();
  if (settings.breakerTripped) {
    await prisma.settings.update({ where: { id: settings.id }, data: { breakerTripped: false, breakerReason: null, breakerDailyPnl: null } });
  }
}

export async function tripCircuitBreaker(reason: string, dailyPnl: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.breakerTripped) {
    await prisma.settings.update({ where: { id: settings.id }, data: { breakerTripped: true, breakerReason: reason, breakerDailyPnl: dailyPnl } });
  }
}