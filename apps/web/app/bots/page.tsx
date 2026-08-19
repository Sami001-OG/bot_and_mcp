'use client';

import { Bot, CirclePlus, Copy, Pause, Play, RefreshCw, Settings2, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell, { type ShellContext } from '../components/AppShell';
import { ApiHttpError, apiFetch, type AuthSession } from '../../lib/session';

type BotStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'ERROR';
type Allocation = { mode: 'PERCENT_EQUITY' | 'PERCENT_MAX_EQUITY' | 'FIXED_AMOUNT' | 'RISK_PERCENT'; percent?: number; amount?: string };
type BotConfig = {
  symbols: string[];
  allocation?: Allocation;
  leverage?: number;
  stopLoss?: string;
  takeProfits?: string[];
  requireSignalStopLoss?: boolean;
  actions?: string[];
  dca?: { enabled: boolean; triggerDropPercent: number; stepDropPercent?: number; amountMode: 'FIXED' | 'PERCENT_EQUITY'; amount: number; maxSteps: number };
  breakeven?: { enabled: boolean; moveAtProfitPercent: number; safeProfitPercent?: number };
  partialTps?: { enabled: boolean; levels: Array<{ pricePercent: number; closePercent: number }> };
};

type Market = { symbol: string; base: string; quote: string; type: string; active: boolean };
type ExchangeAccountRef = { id: string; label: string | null; exchange: string; marketType: string; isPrimary?: boolean };
type BotSummary = {
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
type BotVersion = { id: string; version: number; config: BotConfig; checksum: string; createdAt: string };
type BotRun = { id: string; startedAt: string; stoppedAt: string | null; status: string; metrics: Record<string, unknown> };
type BotDetail = BotSummary & { versions: BotVersion[]; runs: BotRun[] };

type CreateResult = { bot: BotSummary; webhook: { id: string; url: string; signingSecret: string }; mcp: { url: string; password: string } };
type SecretReveal = { botName: string; url: string; signingSecret: string; mcpUrl: string };

type EditTarget = { id: string; name: string; config: BotConfig };

const ACTION_OPTIONS = ['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'REVERSE', 'PARTIAL_EXIT'] as const;
const ALLOCATION_OPTIONS = ['NONE', 'PERCENT_EQUITY', 'PERCENT_MAX_EQUITY', 'FIXED_AMOUNT', 'RISK_PERCENT'] as const;

const STATUS_TONES: Record<BotStatus, string> = { ACTIVE: 'ok', PAUSED: 'warn', STOPPED: 'muted', ERROR: 'bad', DRAFT: 'muted' };

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function webhookUrl(id: string): string {
  return `${window.location.origin}/api/webhooks/tradingview/${id}`;
}

function botMcpUrl(botId: string): string {
  return `${window.location.origin}/api/mcp/bots/${botId}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function formatAllocation(allocation?: Allocation): string {
  if (!allocation) return '';
  const value = allocation.mode === 'FIXED_AMOUNT' ? `$${allocation.amount}` : `${allocation.percent}%`;
  const label = { PERCENT_EQUITY: 'Eq', PERCENT_MAX_EQUITY: 'PeakEq', FIXED_AMOUNT: 'Fixed', RISK_PERCENT: 'Risk' }[allocation.mode];
  return `${label} ${value}`;
}

function formatConfig(config: BotConfig): string {
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
  return parts.join(' · ');
}

function SymbolPicker({ markets, marketsError, onRetryMarkets, selected, onChange, marketType }: { markets: Market[] | null; marketsError: string | null; onRetryMarkets: () => void; selected: string[]; onChange: (next: string[]) => void; marketType?: string }) {
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');

  const typeFilter = marketType?.toUpperCase() === 'SPOT' ? 'spot' : 'swap';
  const scoped = (markets ?? []).filter((market) => market.type === typeFilter);

  const toggle = (symbol: string) => onChange(selected.includes(symbol) ? selected.filter((item) => item !== symbol) : [...selected, symbol]);
  const queryUpper = query.trim().toUpperCase();
  const known = new Set(scoped.map((market) => market.symbol));
  const matching = scoped.filter((market) => market.symbol.toUpperCase().includes(queryUpper));
  const orphaned = selected.filter((symbol) => !known.has(symbol));
  const addMatches = () => onChange([...selected, ...matching.map((market) => market.symbol).filter((symbol) => !selected.includes(symbol))]);
  const addAll = () => onChange([...selected, ...scoped.map((market) => market.symbol).filter((symbol) => !selected.includes(symbol))]);
  const addCustom = () => {
    const trimmed = custom.trim().toUpperCase();
    if (trimmed && !selected.includes(trimmed)) onChange([...selected, trimmed]);
    setCustom('');
  };

  return (
    <label className="symbol-picker">
      <span>Symbols — {selected.length} selected</span>
      <div className="symbol-tools">
        <input className="symbol-search" onChange={(event) => setQuery(event.target.value)} placeholder="Search pairs (BTC, ETH, DOGE…)" type="search" value={query} />
        <div className="symbol-actions">
          <button disabled={!queryUpper} onClick={addMatches} type="button">Add all matches</button>
          <button disabled={scoped.length === 0} onClick={addAll} type="button">Select all</button>
          <button disabled={selected.length === 0} onClick={() => onChange([])} type="button">Clear</button>
        </div>
      </div>
      <div className="symbol-list">
        {!markets && !marketsError && <p className="muted small">Loading markets from the exchange…</p>}
        {!markets && marketsError && (
          <div className="symbol-error">
            <p className="muted small">{marketsError}</p>
            <button className="secondary" onClick={onRetryMarkets} type="button"><RefreshCw size={13} /> Retry</button>
          </div>
        )}
        {markets && scoped.length === 0 && <p className="muted small">No markets of this type returned by the exchange.</p>}
        {markets && matching.length === 0 && queryUpper && <p className="muted small">No matching markets.</p>}
        {orphaned.map((symbol) => (
          <label className="symbol-row orphan" key={`custom-${symbol}`}>
            <input checked onChange={() => toggle(symbol)} type="checkbox" />
            <span><b>{symbol}</b><em>custom pair</em></span>
          </label>
        ))}
        {matching.slice(0, 200).map((market) => (
          <label className="symbol-row" key={market.symbol}>
            <input checked={selected.includes(market.symbol)} onChange={() => toggle(market.symbol)} type="checkbox" />
            <span><b>{market.symbol}</b><em>{market.base} · {market.quote}</em></span>
          </label>
        ))}
        {matching.length > 200 && <p className="muted small">Showing first 200 matches — refine your search.</p>}
      </div>
      <div className="symbol-custom">
        <input onChange={(event) => setCustom(event.target.value)} placeholder="Add custom pair not listed, e.g. BTCUSD" type="text" value={custom} />
        <button disabled={!custom.trim()} onClick={addCustom} type="button">Add</button>
      </div>
      <input name="symbols" readOnly type="hidden" value={selected.join(', ')} />
    </label>
  );
}

export default function BotsConsole() {
  return (
    <AppShell active="bots">
      {({ session, setNotice, signOut }) => <BotsBody session={session} setNotice={setNotice} signOut={signOut} />}
    </AppShell>
  );
}

function BotsBody({ session, setNotice, signOut }: { session: AuthSession; setNotice: ShellContext['setNotice']; signOut: ShellContext['signOut'] }) {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ExchangeAccountRef[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selected, setSelected] = useState<BotDetail | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [secretReveal, setSecretReveal] = useState<SecretReveal | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadMarkets = useCallback(async () => {
    try {
      const data = await apiFetch<{ symbols: Market[] }>('/api/markets?quote=USDT', session);
      setMarkets(data.symbols);
      setMarketsError(null);
    } catch (error) {
      setMarkets(null);
      setMarketsError(error instanceof Error ? error.message : 'Failed to load markets from the exchange.');
    }
  }, [session]);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await apiFetch<{ accounts: ExchangeAccountRef[] }>('/api/exchange-accounts', session);
      setAccounts(data.accounts);
      const primary = data.accounts.find((account) => account.isPrimary) ?? data.accounts[0];
      setSelectedAccountId(primary?.id ?? '');
    } catch {
      setAccounts([]);
    }
  }, [session]);

  const loadBots = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ bots: BotSummary[] }>('/api/bots', session);
      setBots(data.bots);
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 401) {
        signOut();
        setNotice({ tone: 'error', message: 'Session expired — sign in again.' });
      } else {
        setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load bots.' });
      }
    } finally {
      setLoading(false);
    }
  }, [session, setNotice, signOut]);

  const loadDetail = useCallback(async (botId: string) => {
    try {
      const data = await apiFetch<{ bot: BotDetail }>(`/api/bots/${botId}`, session);
      setSelected(data.bot);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load bot detail.' });
    }
  }, [session, setNotice]);

  useEffect(() => {
    void loadBots();
    void loadMarkets();
    void loadAccounts();
  }, [loadBots, loadMarkets, loadAccounts]);

  const openCreate = () => {
    setEditTarget(null);
    setSymbols([]);
    const primary = accounts.find((account) => account.isPrimary) ?? accounts[0];
    setSelectedAccountId(primary?.id ?? '');
    setCreateOpen(true);
    setNotice(null);
  };

  const openEdit = (bot: BotSummary) => {
    const configSymbols = bot.config?.symbols ?? [];
    setSymbols(configSymbols);
    setEditTarget({ id: bot.id, name: bot.name, config: bot.config });
    setCreateOpen(true);
    setNotice(null);
  };

  const persistBot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    setSaving(true);
    const form = new FormData(event.currentTarget);
    const symbols = String(form.get('symbols') ?? '')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length === 0) {
      setNotice({ tone: 'error', message: 'Enter at least one symbol, e.g. BTC/USDT.' });
      setSaving(false);
      return;
    }
    if (!editTarget && !selectedAccountId) {
      setNotice({ tone: 'error', message: 'Choose the exchange API this bot trades with.' });
      setSaving(false);
      return;
    }
    const config: BotConfig = { symbols };
    const allocationMode = String(form.get('allocationMode') ?? 'NONE');
    const allocationValue = String(form.get('allocationValue') ?? '').trim();
    if (allocationMode !== 'NONE' && allocationValue) {
      config.allocation = allocationMode === 'FIXED_AMOUNT'
        ? { mode: 'FIXED_AMOUNT', amount: allocationValue }
        : { mode: allocationMode as Allocation['mode'], percent: Number(allocationValue) };
    }
    const leverage = Number(form.get('leverage'));
    if (leverage >= 1) config.leverage = leverage;
    const stopLoss = String(form.get('stopLoss') ?? '').trim();
    if (stopLoss) config.stopLoss = stopLoss;
    const takeProfits = String(form.get('takeProfits') ?? '')
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean);
    if (takeProfits.length > 0) config.takeProfits = takeProfits;
    config.requireSignalStopLoss = form.get('requireSignalStopLoss') === 'on';
    const actions = form.getAll('actions') as string[];
    if (actions.length > 0) config.actions = actions;
    if (form.get('dcaEnabled') === 'on') {
      config.dca = {
        enabled: true,
        triggerDropPercent: Number(form.get('dcaTriggerDropPercent')),
        ...(Number(form.get('dcaStepDropPercent')) > 0 ? { stepDropPercent: Number(form.get('dcaStepDropPercent')) } : {}),
        amountMode: String(form.get('dcaAmountMode')) as 'FIXED' | 'PERCENT_EQUITY',
        amount: Number(form.get('dcaAmount')),
        maxSteps: Number(form.get('dcaMaxSteps')),
      };
    }
    if (form.get('breakevenEnabled') === 'on') {
      config.breakeven = {
        enabled: true,
        moveAtProfitPercent: Number(form.get('breakevenMoveAtProfitPercent')),
        ...(Number(form.get('breakevenSafeProfitPercent')) > 0 ? { safeProfitPercent: Number(form.get('breakevenSafeProfitPercent')) } : {}),
      };
    }
    if (form.get('partialTpsEnabled') === 'on') {
      const levels = String(form.get('partialTpLevels') ?? '')
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => pair.split(':'))
        .map(([priceRaw, closeRaw]) => ({ pricePercent: Number(priceRaw), closePercent: Number(closeRaw) }))
        .filter((level) => Number.isFinite(level.pricePercent) && level.pricePercent > 0 && Number.isFinite(level.closePercent) && level.closePercent > 0);
      if (levels.length > 0) config.partialTps = { enabled: true, levels };
    }

    try {
      if (editTarget) {
        await apiFetch(`/api/bots/${editTarget.id}`, session, { method: 'PATCH', body: { config } });
        setNotice({ tone: 'success', message: `Bot "${editTarget.name}" updated (new version created).` });
      } else {
        const name = String(form.get('name') ?? '').trim();
        const password = String(form.get('password') ?? '').trim();
        const result = await apiFetch<CreateResult>('/api/bots', session, { method: 'POST', body: { name, exchangeAccountId: selectedAccountId, ...(password ? { password } : {}), config } });
        setSecretReveal({
          botName: result.bot.name,
          url: webhookUrl(result.webhook.id),
          signingSecret: result.webhook.signingSecret,
          mcpUrl: botMcpUrl(result.bot.id),
        });
        setNotice({ tone: 'success', message: `Bot "${result.bot.name}" created and ACTIVE.` });
      }
      setCreateOpen(false);
      await loadBots();
      if (selected) void loadDetail(selected.id);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to save bot.' });
    } finally {
      setSaving(false);
    }
  };

  const setBotStatus = async (bot: BotSummary, action: 'pause' | 'resume' | 'stop') => {
    if (!session) return;
    try {
      await apiFetch(`/api/bots/${bot.id}/${action}`, session, { method: 'POST', body: {} });
      const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'stopped';
      setNotice({ tone: 'success', message: `Bot "${bot.name}" ${verb}.` });
      await loadBots();
      if (selected?.id === bot.id) void loadDetail(bot.id);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Status change failed.' });
    }
  };

  const deleteBot = async (bot: BotSummary) => {
    if (!session) return;
    if (!window.confirm(`Delete bot "${bot.name}" permanently? Its webhook endpoint, runs and versions are removed.`)) return;
    try {
      await apiFetch(`/api/bots/${bot.id}`, session, { method: 'DELETE' });
      setNotice({ tone: 'success', message: `Bot "${bot.name}" deleted.` });
      if (selected?.id === bot.id) setSelected(null);
      await loadBots();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not delete bot.' });
    }
  };

  const deleteAllBots = async () => {
    if (!session) return;
    if (!window.confirm(`Delete ALL ${bots.length} bot(s)? Their webhook endpoints, runs and versions are removed. This cannot be undone.`)) return;
    try {
      const result = await apiFetch<{ deleted: number }>('/api/bots', session, { method: 'DELETE' });
      setNotice({ tone: 'success', message: `Deleted ${result.deleted} bot(s).` });
      setSelected(null);
      await loadBots();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not delete bots.' });
    }
  };

  const prefill = editTarget?.config;

  return (
    <>
        <header>
          <div>
            <p className="eyebrow">AUTOMATED TRADING</p>
            <h1>Bots</h1>
            <p className="muted">Webhook bots trade exclusively — signals and MCP trades only execute through ACTIVE bots.</p>
          </div>
          <div className="header-actions">
            {bots.length > 0 && <button className="secondary danger" disabled={loading} onClick={() => void deleteAllBots()} type="button"><Trash2 size={15} /> Delete all</button>}
            <button className="primary" onClick={openCreate} type="button"><CirclePlus size={17} /> New bot</button>
          </div>
        </header>

        <div className="bot-layout">
          <article className="bot-list-card">
            <div className="card-head">
              <div><p>BOTS</p><h2>{bots.length} configured</h2></div>
              <button className="secondary" disabled={loading} onClick={() => void loadBots()} type="button"><RefreshCw size={14} /> Refresh</button>
            </div>
            <div className="table-scroll">
              {!loading && bots.length === 0 && <p className="muted empty">No bots yet — create one to connect a TradingView webhook.</p>}
              {bots.length > 0 && (
                <table>
                  <thead><tr><th>Bot</th><th>Webhook</th><th>Status</th><th>Version</th><th>Config</th><th>Actions</th></tr></thead>
                  <tbody>
                    {bots.map((bot) => (
                      <tr className={selected?.id === bot.id ? 'selected-row' : ''} key={bot.id} onClick={() => void loadDetail(bot.id)}>
                        <td><b>{bot.name}</b><small className="muted block">{bot.type}{bot.exchangeAccount ? ` · ${bot.exchangeAccount.label ?? bot.exchangeAccount.exchange} ${bot.exchangeAccount.marketType}` : ''}</small></td>
                        <td className="webhook-cell">
                          {bot.webhook ? (
                            <button
                              className="wh-copy"
                              onClick={async (event) => {
                                event.stopPropagation();
                                const copied = await copyText(webhookUrl(bot.webhook!.id));
                                setNotice(copied ? { tone: 'success', message: `Webhook URL for "${bot.name}" copied.` } : { tone: 'error', message: 'Could not copy — select the URL manually.' });
                              }}
                              title="Copy webhook URL"
                              type="button"
                            >
                              <code>/{bot.webhook.id.slice(0, 8)}</code><Copy size={13} />
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td><span className={`status-label ${STATUS_TONES[bot.status]}`}>{bot.status}</span></td>
                        <td>v{bot.activeVersion}</td>
                        <td className="config-cell" title={formatConfig(bot.config)}>{formatConfig(bot.config)}</td>
                        <td className="row-actions" onMouseDown={(event) => event.stopPropagation()}>
                          {bot.status !== 'ACTIVE' && <button className="icon-btn safe" onClick={() => void setBotStatus(bot, 'resume')} title="Resume" type="button"><Play size={14} /></button>}
                          {bot.status === 'ACTIVE' && <button className="icon-btn" onClick={() => void setBotStatus(bot, 'pause')} title="Pause" type="button"><Pause size={14} /></button>}
                          <button className="icon-btn" onClick={() => openEdit(bot)} title="Edit config" type="button"><Settings2 size={14} /></button>
                          {bot.status !== 'STOPPED' && <button className="icon-btn danger" onClick={() => void setBotStatus(bot, 'stop')} title="Stop" type="button"><Square size={14} /></button>}
                          <button className="icon-btn danger" onClick={() => void deleteBot(bot)} title="Delete permanently" type="button"><Trash2 size={14} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </article>

          {selected ? (
            <article className="bot-detail-card">
              <div className="card-head">
                <div>
                  <p>BOT DETAIL</p>
                  <h2>{selected.name}</h2>
                  <small className="muted">v{selected.activeVersion}</small>
                </div>
                <button aria-label="Close detail" className="icon-btn" onClick={() => setSelected(null)} type="button"><X size={16} /></button>
              </div>
              <p className="muted small config-line">{formatConfig(selected.config)}</p>
              {selected.webhook && (
                <div className="bot-webhook">
                  <p className="eyebrow">WEBHOOK ENDPOINT</p>
                  <div className="wh-row">
                    <code className="wh-url">{webhookUrl(selected.webhook.id)}</code>
                    <button className="secondary sm" onClick={() => void copyText(webhookUrl(selected.webhook!.id))} type="button"><Copy size={14} /> Copy URL</button>
                  </div>
                  <p className="muted small">
                    TradingView strategy alerts sent to this URL run <b>only this bot</b> · leverage {selected.config.leverage ?? '1'}x
                  </p>
                  <p className="eyebrow" style={{ marginTop: '0.75rem' }}>MCP ENDPOINT</p>
                  <div className="wh-row">
                    <code className="wh-url">{botMcpUrl(selected.id)}</code>
                    <button className="secondary sm" onClick={() => void copyText(botMcpUrl(selected.id))} type="button"><Copy size={14} /> Copy URL</button>
                  </div>
                  <p className="muted small">
                    MCP client: <code>npx mcp-remote {botMcpUrl(selected.id)}</code> — authenticate with the bot&apos;s webhook signing secret.
                  </p>
                </div>
              )}
              <h3>Runs <span className="muted">(last {selected.runs.length})</span></h3>
              {selected.runs.length === 0 && <p className="muted empty">No runs yet — every routed webhook signal records a run.</p>}
              <div className="timeline">
                {selected.runs.map((run) => (
                  <div className="timeline-item" key={run.id}>
                    <span className={`dot ${run.status === 'ERROR' ? 'warn' : 'ok'}`} />
                    <div className="timeline-body">
                      <div className="timeline-head">
                        <b>{String(run.metrics.action ?? run.status)}</b>
                        <span className={`status-label ${run.status === 'ERROR' ? 'bad' : 'ok'}`}>{run.status}</span>
                        <em>{formatTime(run.startedAt)}</em>
                      </div>
                      <div className="timeline-meta">
                        {typeof run.metrics.symbol === 'string' && <span>{run.metrics.symbol}</span>}
                        {typeof run.metrics.price === 'string' && <span>mark {run.metrics.price}</span>}
                        {Array.isArray(run.metrics.orders) && <span>{run.metrics.orders.length} orders</span>}
                        {Array.isArray(run.metrics.skipped) && run.metrics.skipped.length > 0 && <span className="loss">{run.metrics.skipped.length} skipped</span>}
                        {typeof run.metrics.error === 'string' && <span className="loss">{run.metrics.error}</span>}
                      </div>
                      {Array.isArray(run.metrics.skipped) && run.metrics.skipped.length > 0 && <p className="muted small line-clamp">{String(run.metrics.skipped.join(' · '))}</p>}
                    </div>
                  </div>
                ))}
              </div>
              <h3>Versions</h3>
              <div className="versions">
                {selected.versions.map((version) => (
                  <div className="version-row" key={version.id}>
                    <span className={`status-label ${version.version === selected.activeVersion ? 'ok' : 'muted'}`}>v{version.version}</span>
                    <code title={formatConfig(version.config)}>{formatConfig(version.config)}</code>
                    <em>{formatTime(version.createdAt)}</em>
                  </div>
                ))}
              </div>
            </article>
          ) : (
            <article className="bot-detail-card placeholder"><Bot size={28} /><p>Select a bot to view its runs timeline and version history.</p></article>
          )}
        </div>

      {secretReveal && (
        <div className="modal-backdrop" onMouseDown={() => setSecretReveal(null)} role="presentation">
          <section aria-modal="true" className="modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="card-head">
              <div><p className="eyebrow">ONE-TIME SECRET</p><h2>Webhook &amp; MCP access for “{secretReveal.botName}”</h2></div>
              <button aria-label="Close" onClick={() => setSecretReveal(null)} type="button"><X size={18} /></button>
            </div>
            <p className="muted small">Copy these into your TradingView strategy alert and MCP client. The password is shown <b>only now</b> — it signs webhooks (HMAC) and authorizes MCP.</p>
            <label className="secret-field">
              <span>Webhook URL</span>
              <div className="secret-box"><code>{secretReveal.url}</code><button className="secondary sm" onClick={() => void copyText(secretReveal.url)} type="button"><Copy size={14} /> Copy</button></div>
            </label>
            <label className="secret-field">
              <span>MCP URL</span>
              <div className="secret-box"><code>{secretReveal.mcpUrl}</code><button className="secondary sm" onClick={() => void copyText(secretReveal.mcpUrl)} type="button"><Copy size={14} /> Copy</button></div>
            </label>
            <label className="secret-field">
              <span>Password (webhook HMAC secret = MCP Bearer token)</span>
              <div className="secret-box"><code>{secretReveal.signingSecret}</code><button className="secondary sm" onClick={() => void copyText(secretReveal.signingSecret)} type="button"><Copy size={14} /> Copy</button></div>
            </label>
            <div className="modal-actions">
              <button className="primary" onClick={() => setSecretReveal(null)} type="button">Done</button>
            </div>
          </section>
        </div>
      )}

      {createOpen && (
        <div className="modal-backdrop" onMouseDown={() => setCreateOpen(false)} role="presentation">
          <section aria-modal="true" className="modal wide" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="card-head">
              <div><p className="eyebrow">{editTarget ? 'EDIT CONFIG' : 'AUTOMATION'}</p><h2>{editTarget ? `Edit ${editTarget.name}` : 'New webhook bot'}</h2></div>
              <button aria-label="Close" onClick={() => setCreateOpen(false)} type="button"><X size={18} /></button>
            </div>
            <form key={`${editTarget?.id ?? 'new'}:${createOpen}`} onSubmit={persistBot}>
              {!editTarget && (
                <>
                  <label>Name<input minLength={1} name="name" placeholder="e.g. btc-breakout" required /></label>
                  <label>Webhook / MCP password<input autoComplete="new-password" minLength={12} name="password" placeholder="12+ chars — leave empty to auto-generate" type="text" /></label>
                  <p className="muted small pad-top">This password is the webhook HMAC signing secret <b>and</b> the MCP Bearer token — shown once after creation.</p>
                  <label>
                    Exchange API (credentials)
                    <select name="exchangeAccountId" onChange={(event) => setSelectedAccountId(event.target.value)} required value={selectedAccountId}>
                      {accounts.length === 0 && <option value="">No APIs — add one in Exchange APIs first</option>}
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.label ?? `${account.exchange} ${account.marketType}`}{account.isPrimary ? ' (primary)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {editTarget && (
                <p className="muted small pad-top">
                  Trading API: <b>{editTarget.config ? '—' : ''}</b>
                  {selected && selected.exchangeAccount ? `${selected.exchangeAccount.label ?? selected.exchangeAccount.exchange} ${selected.exchangeAccount.marketType}` : 'bound at creation'}
                </p>
              )}
              <SymbolPicker
                markets={markets}
                marketsError={marketsError}
                onRetryMarkets={() => void loadMarkets()}
                onChange={setSymbols}
                selected={symbols}
                {...(editTarget ? (selected?.exchangeAccount?.marketType ? { marketType: selected.exchangeAccount.marketType } : {}) : (accounts.find((account) => account.id === selectedAccountId)?.marketType ? { marketType: accounts.find((account) => account.id === selectedAccountId)!.marketType } : {}))}
              />
              <div className="form-row">
                <label>Allocation mode<select defaultValue={prefill?.allocation?.mode ?? 'NONE'} name="allocationMode">{ALLOCATION_OPTIONS.map((mode) => <option key={mode} value={mode}>{mode === 'NONE' ? 'Use signal size' : mode}</option>)}</select></label>
                <label>Amount / percent<input defaultValue={prefill?.allocation?.mode === 'FIXED_AMOUNT' ? prefill.allocation.amount : prefill?.allocation?.percent ?? ''} min="0.001" name="allocationValue" step="any" type="number" /></label>
              </div>
              <div className="form-row">
                <label>Leverage<input defaultValue={prefill?.leverage ?? ''} min="1" max="200" name="leverage" type="number" /></label>
                <label>Stop loss price<input defaultValue={prefill?.stopLoss ?? ''} name="stopLoss" placeholder="90000" type="text" /></label>
              </div>
              <label>Take profits (comma separated)<input defaultValue={prefill?.takeProfits?.join(', ') ?? ''} name="takeProfits" placeholder="100000, 110000" type="text" /></label>
              <label className="checkbox"><input defaultChecked={prefill?.requireSignalStopLoss} name="requireSignalStopLoss" type="checkbox" /> Require a stop loss before entering</label>
              <fieldset className="action-field">
                <legend>Allowed signal actions</legend>
                <div className="action-grid">
                  {ACTION_OPTIONS.map((action) => (
                    <label key={action}><input defaultChecked={prefill?.actions?.includes(action) ?? false} name="actions" type="checkbox" value={action} /> {action}</label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="action-field">
                <legend>DCA — average down</legend>
                <label className="checkbox"><input defaultChecked={prefill?.dca?.enabled ?? false} name="dcaEnabled" type="checkbox" /> Automatically add to a losing position</label>
                <div className="form-row">
                  <label>Trigger drop %<input defaultValue={prefill?.dca?.triggerDropPercent ?? 3} min="0.1" name="dcaTriggerDropPercent" step="any" type="number" /></label>
                  <label>Step drop % (optional)<input defaultValue={prefill?.dca?.stepDropPercent ?? ''} min="0.1" name="dcaStepDropPercent" step="any" type="number" /></label>
                </div>
                <div className="form-row">
                  <label>Amount mode<select defaultValue={prefill?.dca?.amountMode ?? 'FIXED'} name="dcaAmountMode"><option value="FIXED">Fixed $ amount</option><option value="PERCENT_EQUITY">% of equity</option></select></label>
                  <label>Amount per step<input defaultValue={prefill?.dca?.amount ?? 50} min="0.01" name="dcaAmount" step="any" type="number" /></label>
                  <label>Max steps<input defaultValue={prefill?.dca?.maxSteps ?? 3} min="1" max="20" name="dcaMaxSteps" type="number" /></label>
                </div>
                <p className="muted small">Evaluated on every run: when price drops {prefill?.dca?.triggerDropPercent ?? 3}% below entry, an extra entry is added (one step per run, up to max steps).</p>
              </fieldset>

              <fieldset className="action-field">
                <legend>Breakeven stop-loss move</legend>
                <label className="checkbox"><input defaultChecked={prefill?.breakeven?.enabled ?? false} name="breakevenEnabled" type="checkbox" /> Move the stop loss to breakeven when in profit</label>
                <div className="form-row">
                  <label>Move at profit %<input defaultValue={prefill?.breakeven?.moveAtProfitPercent ?? 2} min="0.1" name="breakevenMoveAtProfitPercent" step="any" type="number" /></label>
                  <label>Safe profit % (optional)<input defaultValue={prefill?.breakeven?.safeProfitPercent ?? ''} min="0.01" name="breakevenSafeProfitPercent" step="any" type="number" /></label>
                </div>
                <p className="muted small">When price moves {prefill?.breakeven?.moveAtProfitPercent ?? 2}% in favor, the stop loss moves to entry (or entry + safe profit %).</p>
              </fieldset>

              <fieldset className="action-field">
                <legend>Partial take-profit claims</legend>
                <label className="checkbox"><input defaultChecked={prefill?.partialTps?.enabled ?? false} name="partialTpsEnabled" type="checkbox" /> Claim a percentage of the position at each TP level</label>
                <label>TP levels (price% : close%)<input defaultValue={prefill?.partialTps?.levels.map((level) => `${level.pricePercent}:${level.closePercent}`).join(', ') ?? ''} name="partialTpLevels" placeholder="2:30, 5:30, 10:40" type="text" /></label>
                <p className="muted small">Comma separated, e.g. <code>2:30, 5:40, 10:30</code> closes 30% at +2%, 40% at +5%, 30% at +10%. Levels must sum to 100% or less.</p>
              </fieldset>
              <div className="modal-actions">
                <button className="secondary" onClick={() => setCreateOpen(false)} type="button">Cancel</button>
                <button className="primary" disabled={saving} type="submit">{saving ? 'Saving…' : editTarget ? 'Save config' : 'Create bot'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}