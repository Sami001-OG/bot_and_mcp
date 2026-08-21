export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export type Market = { symbol: string; base: string; quote: string; type: string; active: boolean };
export type Balance = { asset: string; free: string; locked: string; total: string };

export type Execution = {
  id: string;
  exchangeExecutionId: string | null;
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string | null;
  executedAt: string | null;
};

export type OrderRow = {
  id: string;
  state: string;
  side: string;
  positionSide: string;
  symbol: string;
  orderType: string;
  marketType: string;
  quantity: string;
  price: string | null;
  stopPrice: string | null;
  reduceOnly: boolean;
  rejectionReason: string | null;
  createdAt: string;
  executions: Execution[];
};

export type PlaceResult = {
  accepted: boolean;
  order: { id: string; state: string; symbol: string; side: string; quantity: string };
  marketPrice?: string;
  sized?: { quantity: string; notional: string; leverage?: number };
  execution?: { state: string; exchangeOrderId?: string; filled?: number; error?: string };
  duplicate?: boolean;
};

export type BotStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'ERROR';
export type AllocationMode = 'PERCENT_EQUITY' | 'PERCENT_MAX_EQUITY' | 'FIXED_AMOUNT' | 'RISK_PERCENT';
export type Allocation = { mode: AllocationMode; percent?: number; amount?: string };
export type DcaConfig = {
  enabled: boolean;
  triggerDropPercent: number;
  stepDropPercent?: number;
  amountMode: 'FIXED' | 'PERCENT_EQUITY';
  amount: number;
  maxSteps: number;
};
export type BreakevenConfig = { enabled: boolean; moveAtProfitPercent: number; safeProfitPercent?: number };
export type PartialTpLevel = { pricePercent: number; closePercent: number };
export type PartialTpsConfig = { enabled: boolean; levels: PartialTpLevel[] };
export type TrailingConfig = { enabled: boolean; callbackPercent: number };
export type BotConfig = {
  marketType?: 'SPOT' | 'USDT_FUTURES';
  symbols: string[];
  allocation?: Allocation;
  leverage?: number;
  stopLoss?: string;
  takeProfits?: string[];
  requireSignalStopLoss?: boolean;
  actions?: string[];
  dca?: DcaConfig;
  breakeven?: BreakevenConfig;
  partialTps?: PartialTpsConfig;
  trailing?: TrailingConfig;
};

export type ExchangeAccountRef = { id: string; label: string | null; exchange: string; marketType: string; isPrimary?: boolean };
export type BotSummary = {
  id: string;
  name: string;
  type: string;
  status: BotStatus;
  activeVersion: number;
  config: BotConfig;
  createdAt: string;
  updatedAt: string;
  exchangeAccount?: ExchangeAccountRef | null;
  webhook?: { id: string; active: boolean } | null;
};
export type BotVersion = { id: string; version: number; config: BotConfig; checksum: string; createdAt: string };
export type BotRun = { id: string; startedAt: string; stoppedAt: string | null; status: string; metrics: Record<string, unknown> };
export type BotDetail = BotSummary & { versions: BotVersion[]; runs: BotRun[] };
export type BotCreateResult = { bot: BotSummary; webhook: { id: string; url: string; signingSecret: string }; mcp: { url: string; password: string } };
export type BotSecretReveal = { botName: string; url: string; signingSecret: string; mcpUrl: string };

export type ExchangeAccount = {
  id: string;
  exchange: string;
  marketType: string;
  label: string | null;
  isPrimary: boolean;
  testnet: boolean;
  keyPreview: string;
  botCount: number;
  createdAt: string;
};

export type LedgerPosition = {
  symbol: string;
  side: string;
  quantity: string;
  averageEntryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  leverage: number;
  liquidationPrice?: string;
  marginMode: string;
  updatedAt: string;
};

export type RealizedRow = { symbol: string; realizedPnl: string; fills: number };

export type PnlResponse = {
  since: string;
  positions: LedgerPosition[];
  realizedBySymbol: RealizedRow[];
  totals: { unrealized: string; realized: string; openPositions: number; ledgerRows: number };
  generatedAt: string;
  live: boolean;
};

export type ExecutionRow = {
  orderId: string;
  state: string;
  side: string;
  positionSide: string;
  symbol: string;
  marketType: string;
  exchange: string;
  label: string;
  executionId: string | null;
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string | null;
  executedAt: string | null;
  createdAt: string;
};

export type AppNotification = {
  id: string;
  channel: string;
  severity: string;
  title: string;
  message?: string | null;
  payload?: unknown;
  readAt: string | null;
  createdAt: string;
};

export type RiskSettings = {
  mcpUrl: string;
  tradingEnabled: boolean;
  liveTradingAcknowledgedAt: string | null;
  dailyLossLimit: string | null;
  dailyRealizedPnl: string;
  breakerTripped: boolean;
  breakerReason: string | null;
  breakerDailyPnl?: string | null;
  equity?: string | null;
  peakEquity?: string | null;
  exchange?: string;
  marketType?: string;
  accountLabel?: string | null;
  accountId?: string | null;
  accounts?: ExchangeAccount[];
};