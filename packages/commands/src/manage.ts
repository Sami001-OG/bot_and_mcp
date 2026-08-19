import { Prisma } from '@platform/database';
import { MIN_ORDER_NOTIONAL_USD, type BreakevenConfig, type DcaConfig, type ManagementOverrides, type PartialTpsConfig, type ResolvedOrderRequest, type WebhookBotConfig } from '@platform/contracts';
import { alignAmount } from '@platform/trading-core';
import { evaluateOrder } from '@platform/risk-engine';
import { prisma } from '@platform/database';
import { connectToAccount, marketPrecisionOf } from './account.js';
import { getBotTradeContext } from './bot-trade.js';
import { executeOrderNow, persistOrder } from './execute.js';
import { loadPolicy } from './orders.js';

export type ManageState = {
  dca: Record<string, { steps: number }>;
  breakeven: Record<string, { applied: boolean; target?: string; version?: number }>;
  tps: Record<string, { claimed: number[]; placed: number[] }>;
};

const EMPTY_STATE: ManageState = { dca: {}, breakeven: {}, tps: {} };

export type ManageResult = {
  botId: string;
  positions: number;
  dca: { steps: number; placed: string[]; skipped: string[]; errors: string[] } | null;
  breakeven: { moved: string[]; skipped: string[]; errors: string[] } | null;
  tps: { claimed: string[]; placed: string[]; skipped: string[]; errors: string[] } | null;
  errors: string[];
};

function symbolKey(symbol: string): string {
  return symbol.toUpperCase();
}

export function managePrefix(kind: 'dca' | 'br' | 'tpr' | 'tpc', botId: string, symbol: string): string {
  const tag = kind === 'dca' ? 'btdc' : kind === 'br' ? 'btbr' : kind === 'tpr' ? 'bttp' : 'btcl';
  const sym = symbol.replace(/[/:]/g, '').slice(0, 8);
  return `${tag}-${botId.slice(0, 8)}-${sym}`;
}

export function dcaStepDue(cfg: DcaConfig, dropPct: number, steps: number): number {
  if (dropPct <= 0) return 0;
  const stepDistance = cfg.stepDropPercent ?? cfg.triggerDropPercent;
  const required = cfg.triggerDropPercent + steps * stepDistance;
  if (dropPct < required) return 0;
  const nextStep = steps + 1;
  return nextStep > cfg.maxSteps ? 0 : nextStep;
}

export function breakevenTarget(side: 'LONG' | 'SHORT', entry: number, cfg: BreakevenConfig): number {
  const safe = cfg.safeProfitPercent !== undefined ? cfg.safeProfitPercent / 100 : 0;
  return side === 'LONG' ? entry * (1 + safe) : entry * (1 - safe);
}

async function loadState(botId: string): Promise<ManageState> {
  const row = await prisma.botState.findUnique({ where: { botId } });
  if (!row) return EMPTY_STATE;
  try {
    return { dca: {}, breakeven: {}, tps: {}, ...(row.state as unknown as Partial<ManageState>) };
  } catch {
    return EMPTY_STATE;
  }
}

async function saveState(botId: string, state: ManageState): Promise<void> {
  await prisma.botState.upsert({
    where: { botId },
    update: { state: state as unknown as Prisma.InputJsonValue },
    create: { botId, state: state as unknown as Prisma.InputJsonValue },
  });
}

type ManageCtx = {
  botId: string;
  position: { symbol: string; side: 'LONG' | 'SHORT'; quantity: string };
  closeSide: 'BUY' | 'SELL';
  entry: number;
  mark: number;
  precision: Awaited<ReturnType<typeof marketPrecisionOf>>;
  cancelOpenOrders: (prefix: string) => Promise<string[]>;
  openOrders: Array<{ id: string; symbol: string }>;
  openByClientOrderId: Set<string>;
};

async function placeManagedOrder(input: {
  botId: string;
  position: { symbol: string; side: 'LONG' | 'SHORT'; quantity: string };
  side: 'BUY' | 'SELL';
  clientOrderId: string;
  idempotencyKey: string;
  type: 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  stopPrice?: string;
  reduceOnly: boolean;
  quantity: string;
  feature: 'breakeven' | 'tp' | 'dca';
}): Promise<{ placed: boolean; filled: boolean; error?: string }> {
  try {
    const { order, created } = await persistOrder(
      {
        symbol: input.position.symbol,
        side: input.side,
        positionSide: input.position.side,
        type: input.type,
        quantity: input.quantity,
        ...(input.stopPrice ? { stopPrice: input.stopPrice } : {}),
        reduceOnly: input.reduceOnly,
        postOnly: false,
        clientOrderId: input.clientOrderId,
        idempotencyKey: input.idempotencyKey,
      },
      { source: { kind: 'bot-manage', feature: input.feature, botId: input.botId } },
    );
    if (!created) return { placed: false, filled: false, error: 'duplicate idempotency key; order already exists' };
    const execution = await executeOrderNow(order.id);
    if (execution.error) return { placed: true, filled: false, error: execution.error };
    if (execution.state === 'REJECTED' || execution.state === 'FAILED') return { placed: true, filled: false, error: execution.state };
    return { placed: true, filled: execution.state === 'FILLED' || execution.state === 'PARTIALLY_FILLED' };
  } catch (error) {
    return { placed: false, filled: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

export function mergeManagementOverrides(config: WebhookBotConfig, overrides: ManagementOverrides | undefined): WebhookBotConfig {
  if (!overrides) return config;
  const merged: WebhookBotConfig = { ...config };
  if (overrides.dca) merged.dca = { ...overrides.dca, enabled: overrides.dca.enabled ?? true };
  if (overrides.breakeven) merged.breakeven = { ...overrides.breakeven, enabled: overrides.breakeven.enabled ?? true };
  if (overrides.partialTps) merged.partialTps = { ...overrides.partialTps, enabled: overrides.partialTps.enabled ?? true };
  return merged;
}

export async function manageBotPositions(botId: string, overrides?: ManagementOverrides): Promise<ManageResult> {
  const ctx = await getBotTradeContext(botId);
  ctx.config = mergeManagementOverrides(ctx.config, overrides);
  const result: ManageResult = { botId, positions: 0, dca: null, breakeven: null, tps: null, errors: [] };
  const dcaCfg = ctx.config.dca && ctx.config.dca.enabled ? ctx.config.dca : undefined;
  const brCfg = ctx.config.breakeven && ctx.config.breakeven.enabled ? ctx.config.breakeven : undefined;
  const tpsCfg = ctx.config.partialTps && ctx.config.partialTps.enabled ? ctx.config.partialTps : undefined;
  if (!dcaCfg && !brCfg && !tpsCfg) return result;
  result.dca = dcaCfg ? { steps: 0, placed: [], skipped: [], errors: [] } : null;
  result.breakeven = brCfg ? { moved: [], skipped: [], errors: [] } : null;
  result.tps = tpsCfg ? { claimed: [], placed: [], skipped: [], errors: [] } : null;

  const state = await loadState(botId);
  const policy = await loadPolicy().catch(() => null);
  const session = await connectToAccount(ctx.account.id);
  try {
    const positions = await session.adapter.getPositions();
    const openOrders = await session.adapter.getOrders().catch(() => []);
    const balances = await session.adapter.getBalance().catch(() => []);
    const cancelOpenOrders = async (prefix: string): Promise<string[]> => {
      const canceled: string[] = [];
      for (const order of openOrders) {
        if (!order.clientOrderId || !order.clientOrderId.startsWith(prefix)) continue;
        try {
          await session.adapter.cancelOrder(order.id, order.symbol);
          canceled.push(order.clientOrderId);
        } catch {
          /* leave the order in place */
        }
      }
      return canceled;
    };
    const openByClientOrderId = new Set(openOrders.map((order) => order.clientOrderId).filter(Boolean));

    for (const position of positions) {
      if (!ctx.config.symbols.some((entry) => entry === '*' || entry.toUpperCase().split(':')[0] === position.symbol.toUpperCase())) continue;
      const side = position.side;
      if (side !== 'LONG' && side !== 'SHORT') continue;
      const quantity = Number(position.quantity);
      const entry = Number(position.entryPrice);
      const mark = Number(position.markPrice);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(mark) || mark <= 0) continue;
      result.positions += 1;
      const key = symbolKey(position.symbol);
      const precision = await marketPrecisionOf(session.adapter, position.symbol).catch(() => null);
      const quote = (position.symbol.split('/')[1] ?? 'USDT').split(':')[0];
      const balance = balances.find((entry) => entry.asset === quote);
      const equity = balance ? Number(balance.total) : 0;
      const closeSide: 'BUY' | 'SELL' = side === 'LONG' ? 'SELL' : 'BUY';
      const current = {
        dca: state.dca[key] ?? { steps: 0 },
        breakeven: state.breakeven[key] ?? { applied: false },
        tps: state.tps[key] ?? { claimed: [], placed: [] },
      };
      state.dca[key] = current.dca;
      state.breakeven[key] = current.breakeven;
      state.tps[key] = current.tps;
      const dcaOut = result.dca;
      const brOut = result.breakeven;
      const tpsOut = result.tps;
      const ctxForSymbol: ManageCtx = {
        botId,
        position: { symbol: position.symbol, side, quantity: position.quantity },
        closeSide,
        entry,
        mark,
        precision,
        cancelOpenOrders,
        openOrders,
        openByClientOrderId,
      };

      if (brCfg && brOut) {
        const br = await applyBreakeven(ctxForSymbol, brCfg, current.breakeven);
        if (br.error) brOut.errors.push(br.error);
        else if (br.moved) brOut.moved.push(br.moved);
        else if (br.skipped) brOut.skipped.push(br.skipped);
      }

      if (tpsCfg && tpsOut) {
        const tp = await applyPartialTps(ctxForSymbol, tpsCfg, current.tps, MIN_ORDER_NOTIONAL_USD[ctx.account.marketType]);
        tpsOut.claimed.push(...tp.claimed);
        tpsOut.placed.push(...tp.placed);
        tpsOut.skipped.push(...tp.skipped);
        tpsOut.errors.push(...tp.errors);
      }

      if (dcaCfg && dcaOut) {
        const dca = await applyDca(ctxForSymbol, dcaCfg, current.dca, equity, policy, ctx.account.exchange, ctx.account.marketType, MIN_ORDER_NOTIONAL_USD[ctx.account.marketType]);
        dcaOut.placed.push(...dca.placed);
        dcaOut.skipped.push(...dca.skipped);
        dcaOut.errors.push(...dca.errors);
        dcaOut.steps += dca.steps;
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message.slice(0, 300) : String(error));
  } finally {
    await session.adapter.disconnect().catch(() => undefined);
  }

  await saveState(botId, state).catch((error) => {
    result.errors.push(`State persistence failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  });
  return result;
}

export async function runAllBotManagement(): Promise<Array<{ botId: string; name: string; result: ManageResult } | { botId: string; name: string; error: string }>> {
  const bots = await prisma.bot.findMany({ where: { status: 'ACTIVE', type: 'WEBHOOK' }, select: { id: true, name: true } });
  const summaries: Array<{ botId: string; name: string; result: ManageResult } | { botId: string; name: string; error: string }> = [];
  for (const bot of bots) {
    try {
      summaries.push({ botId: bot.id, name: bot.name, result: await manageBotPositions(bot.id) });
    } catch (error) {
      summaries.push({ botId: bot.id, name: bot.name, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return summaries;
}

async function applyBreakeven(input: ManageCtx, cfg: BreakevenConfig, stateEntry: ManageState['breakeven'][string]): Promise<{ moved?: string; skipped?: string; error?: string }> {
  const long = input.position.side === 'LONG';
  const movedPct = cfg.moveAtProfitPercent / 100;
  const favorable = long ? input.mark >= input.entry * (1 + movedPct) : input.mark <= input.entry * (1 - movedPct);
  if (!favorable) return { skipped: `${input.position.symbol}: price not yet ${cfg.moveAtProfitPercent}% in favor` };
  const target = breakevenTarget(input.position.side, input.entry, cfg);
  const prefix = managePrefix('br', input.botId, input.position.symbol);
  const version = (stateEntry.version ?? 0) + 1;
  const active = `${prefix}-${version - 1}-`;
  const next = `${prefix}-${version}-`;
  if (stateEntry.applied && input.openByClientOrderId.has(active)) {
    return { skipped: `${input.position.symbol}: breakeven SL already active at ${stateEntry.target}` };
  }
  if (stateEntry.applied && input.openByClientOrderId.has(next)) {
    stateEntry.version = version;
    stateEntry.target = target.toFixed(8);
    return { moved: `${input.position.symbol} → SL ${target.toFixed(8)}` };
  }
  await input.cancelOpenOrders(prefix);
  const outcome = await placeManagedOrder({
    botId: input.botId,
    position: input.position,
    side: input.closeSide,
    clientOrderId: next,
    idempotencyKey: `bot:manage:br:${input.botId}:${symbolKey(input.position.symbol)}:${version}`,
    type: 'STOP_MARKET',
    stopPrice: target.toFixed(8),
    reduceOnly: true,
    quantity: input.position.quantity,
    feature: 'breakeven',
  });
  if (outcome.error) return { error: `${input.position.symbol}: breakeven SL failed (${outcome.error})` };
  stateEntry.applied = true;
  stateEntry.target = target.toFixed(8);
  stateEntry.version = version;
  return { moved: `${input.position.symbol} → SL ${target.toFixed(8)}` };
}

async function applyPartialTps(input: ManageCtx, cfg: PartialTpsConfig, stateEntry: ManageState['tps'][string], minNotional: string): Promise<{ claimed: string[]; placed: string[]; skipped: string[]; errors: string[] }> {
  const out = { claimed: [] as string[], placed: [] as string[], skipped: [] as string[], errors: [] as string[] };
  const long = input.position.side === 'LONG';
  const restingPrefix = managePrefix('tpr', input.botId, input.position.symbol);
  for (const index of stateEntry.placed) {
    if (!input.openByClientOrderId.has(`${restingPrefix}-${index}`)) {
      stateEntry.placed = stateEntry.placed.filter((item) => item !== index);
      if (!stateEntry.claimed.includes(index)) stateEntry.claimed.push(index);
    }
  }
  for (const [index, level] of cfg.levels.entries()) {
    if (stateEntry.claimed.includes(index)) continue;
    const trigger = long ? input.entry * (1 + level.pricePercent / 100) : input.entry * (1 - level.pricePercent / 100);
    const portion = Math.floor((Number(input.position.quantity) * level.closePercent) / 100 * 1e8) / 1e8;
    if (portion <= 0) { out.skipped.push(`${input.position.symbol}: TP${index + 1} portion rounds to zero`); continue; }
    const aligned = alignAmount(String(portion), input.precision ?? undefined);
    const portionQty = Number(aligned ?? String(portion));
    if (input.precision?.amountMin !== undefined && Number.isFinite(input.precision.amountMin) && input.precision.amountMin > 0 && portionQty < input.precision.amountMin) {
      out.skipped.push(`${input.position.symbol}: TP${index + 1} portion ${portionQty} below exchange minimum`);
      continue;
    }
    const reached = long ? input.mark >= trigger : input.mark <= trigger;
    if (reached) {
      const outcome = await placeManagedOrder({
        botId: input.botId,
        position: input.position,
        side: input.closeSide,
        clientOrderId: `${managePrefix('tpc', input.botId, input.position.symbol)}-${index}`,
        idempotencyKey: `bot:manage:tp:${input.botId}:${symbolKey(input.position.symbol)}:${index}:${Date.now()}`,
        type: 'MARKET',
        reduceOnly: true,
        quantity: String(portionQty),
        feature: 'tp',
      });
      if (outcome.error) { out.errors.push(`${input.position.symbol}: TP${index + 1} claim failed (${outcome.error})`); continue; }
      if (outcome.filled) {
        stateEntry.claimed.push(index);
        out.claimed.push(`${input.position.symbol} TP${index + 1} @${trigger.toFixed(4)} (${level.closePercent}%)`);
      } else {
        stateEntry.placed = stateEntry.placed.filter((item) => item !== index);
      }
    } else {
      if (new Prisma.Decimal(String(portionQty)).mul(new Prisma.Decimal(trigger)).lessThan(new Prisma.Decimal(minNotional))) {
        out.skipped.push(`${input.position.symbol}: TP${index + 1} portion below min notional $${minNotional}`);
        continue;
      }
      if (stateEntry.placed.includes(index)) continue;
      const outcome = await placeManagedOrder({
        botId: input.botId,
        position: input.position,
        side: input.closeSide,
        clientOrderId: `${restingPrefix}-${index}`,
        idempotencyKey: `bot:manage:tpr:${input.botId}:${symbolKey(input.position.symbol)}:${index}`,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: trigger.toFixed(8),
        reduceOnly: true,
        quantity: String(portionQty),
        feature: 'tp',
      });
      if (outcome.error) { out.errors.push(`${input.position.symbol}: TP${index + 1} order failed (${outcome.error})`); continue; }
      if (outcome.placed) {
        stateEntry.placed.push(index);
        out.placed.push(`${input.position.symbol} TP${index + 1} @${trigger.toFixed(4)}`);
      }
    }
  }
  return out;
}

async function applyDca(input: ManageCtx, cfg: DcaConfig, stateEntry: ManageState['dca'][string], equity: number, policy: Awaited<ReturnType<typeof loadPolicy>> | null, exchange: string, marketType: string, minNotional: string): Promise<{ steps: number; placed: string[]; skipped: string[]; errors: string[] }> {
  const out = { steps: 0, placed: [] as string[], skipped: [] as string[], errors: [] as string[] };
  const long = input.position.side === 'LONG';
  const dropPct = long ? (input.entry - input.mark) / input.entry * 100 : (input.mark - input.entry) / input.entry * 100;
  const nextStep = dcaStepDue(cfg, dropPct, stateEntry.steps);
  if (nextStep === 0) return out;
  const notional = cfg.amountMode === 'FIXED' ? cfg.amount : equity * (cfg.amount / 100);
  if (notional <= 0) { out.skipped.push(`${input.position.symbol}: DCA step ${nextStep} skipped — no equity`); return out; }
  const aligned = alignAmount(String(notional / input.mark), input.precision ?? undefined);
  const qty = Number(aligned ?? String(notional / input.mark));
  if (!Number.isFinite(qty) || qty <= 0) { out.skipped.push(`${input.position.symbol}: DCA step ${nextStep} skipped — quantity rounds to zero`); return out; }
  if (input.precision?.amountMin !== undefined && Number.isFinite(input.precision.amountMin) && input.precision.amountMin > 0 && qty < input.precision.amountMin) {
    out.skipped.push(`${input.position.symbol}: DCA step ${nextStep} skipped — quantity ${qty} below exchange minimum`);
    return out;
  }
  if (new Prisma.Decimal(String(qty)).mul(new Prisma.Decimal(input.mark)).lessThan(new Prisma.Decimal(minNotional))) {
    out.skipped.push(`${input.position.symbol}: DCA step ${nextStep} skipped — below min notional $${minNotional}`);
    return out;
  }
  if (policy) {
    const risk = evaluateOrder({
      exchangeAccountId: '', exchange: exchange as never, marketType: marketType as never,
      symbol: input.position.symbol, side: long ? 'BUY' : 'SELL', positionSide: input.position.side,
      type: 'MARKET', quantity: String(qty), reduceOnly: false, postOnly: false, timeInForce: 'GTC',
      clientOrderId: 'risk-check', idempotencyKey: `risk:${input.botId}:${Date.now()}`,
    }, policy, { equity: String(equity || 0), dailyPnl: '0', weeklyPnl: '0', monthlyPnl: '0', peakEquity: String(equity || 0), exposure: '0', openPositions: 1, consecutiveLosses: 0, markPrice: String(input.mark) });
    if (!risk.approved) { out.skipped.push(`${input.position.symbol}: DCA step ${nextStep} risk rejected (${risk.code})`); return out; }
  }
  const stepKey = `${managePrefix('dca', input.botId, input.position.symbol)}-${nextStep}`;
  const outcome = await placeManagedOrder({
    botId: input.botId,
    position: input.position,
    side: long ? 'BUY' : 'SELL',
    clientOrderId: stepKey,
    idempotencyKey: `bot:manage:dca:${input.botId}:${symbolKey(input.position.symbol)}:${nextStep}:${Date.now()}`,
    type: 'MARKET',
    reduceOnly: false,
    quantity: String(qty),
    feature: 'dca',
  });
  if (outcome.error) { out.errors.push(`${input.position.symbol}: DCA step ${nextStep} failed (${outcome.error})`); return out; }
  if (outcome.filled) {
    stateEntry.steps = nextStep;
    out.steps = 1;
    out.placed.push(`${input.position.symbol} DCA step ${nextStep} qty ${qty} @${input.mark}`);
  }
  return out;
}