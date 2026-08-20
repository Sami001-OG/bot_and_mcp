import type { Allocation, BotConfig, BotStatus, Tone } from './types';

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatNumber(value: string | number, digits = 2): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function formatPnl(value: string | number): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '$0.00';
  return `${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pnlClass(value: string | number): string {
  const amount = typeof value === 'number' ? value : Number(value);
  return amount > 0 ? 'profit' : amount < 0 ? 'loss' : 'muted';
}

export function formatAllocation(allocation?: Allocation): string {
  if (!allocation) return '';
  const value = allocation.mode === 'FIXED_AMOUNT' ? `$${allocation.amount}` : `${allocation.percent}%`;
  const label = { PERCENT_EQUITY: 'Eq', PERCENT_MAX_EQUITY: 'PeakEq', FIXED_AMOUNT: 'Fixed', RISK_PERCENT: 'Risk' }[allocation.mode];
  return `${label} ${value}`;
}

export function formatConfig(config: BotConfig): string {
  const parts: string[] = [config.symbols.join(', ')];
  if (config.leverage) parts.push(`${config.leverage}x`);
  if (config.stopLoss) parts.push(`SL ${config.stopLoss}`);
  if (config.takeProfits?.length) parts.push(`TP ${config.takeProfits.join('/')}`);
  if (config.requireSignalStopLoss) parts.push('SL required');
  const allocation = formatAllocation(config.allocation);
  if (allocation) parts.push(allocation);
  if (config.dca?.enabled) parts.push(`DCA ${config.dca.triggerDropPercent}% x${config.dca.maxSteps}`);
  if (config.breakeven?.enabled) parts.push(`BE @+${config.breakeven.moveAtProfitPercent}%`);
  if (config.partialTps?.enabled) parts.push(`TP ${config.partialTps.levels.map((level) => `${level.pricePercent}:${level.closePercent}`).join('/')}`);
  if (config.trailing?.enabled) parts.push(`Trail ${config.trailing.callbackPercent}%`);
  return parts.join(' · ');
}

export const STATE_TONES: Record<string, Tone> = {
  FILLED: 'ok',
  QUEUED: 'ok',
  RECEIVED: 'muted',
  PLACED: 'warn',
  OPEN: 'warn',
  PARTIALLY_FILLED: 'warn',
  REJECTED: 'bad',
  CANCELED: 'muted',
  FAILED: 'bad',
  EXPIRED: 'muted',
};

export const STATUS_TONES: Record<BotStatus, Tone> = { ACTIVE: 'ok', PAUSED: 'warn', STOPPED: 'muted', ERROR: 'bad', DRAFT: 'muted' };

export const WINDOWS = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 7 * 24 },
  { label: '30d', hours: 30 * 24 },
  { label: 'All time', hours: null },
] as const;

export const ORDER_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP'] as const;
export const SPOT_ORDER_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'] as const;
export const POSITION_SIDES = ['LONG', 'SHORT'] as const;
export const SIDES = ['BUY', 'SELL'] as const;
export const ALLOCATION_MODES = ['FIXED_AMOUNT', 'PERCENT_EQUITY', 'PERCENT_MAX_EQUITY', 'RISK_PERCENT'] as const;
export const MARKET_MODES = [
  { id: 'SPOT', label: 'Spot', hint: 'Buy / sell tokens. No leverage.' },
  { id: 'USDT_FUTURES', label: 'Futures', hint: 'Leveraged positions with long / short.' },
] as const;
export type MarketMode = (typeof MARKET_MODES)[number]['id'];

export const MARKET_TYPES = ['USDT_FUTURES', 'SPOT'] as const;

export const ACTION_OPTIONS = ['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'REVERSE', 'PARTIAL_EXIT'] as const;
export const ALLOCATION_OPTIONS = ['NONE', 'PERCENT_EQUITY', 'PERCENT_MAX_EQUITY', 'FIXED_AMOUNT', 'RISK_PERCENT'] as const;

export const TERMINAL_STATES = new Set(['FILLED', 'REJECTED', 'CANCELED', 'FAILED', 'EXPIRED']);