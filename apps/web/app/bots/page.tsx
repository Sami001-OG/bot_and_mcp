'use client';

import { Bot, CirclePlus, LayoutDashboard, LogOut, Pause, Play, RefreshCw, Settings2, ShieldCheck, Square, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { NexusLogo } from '../logo';
import { ApiHttpError, apiFetch, clearSession, loadSession, login, type AuthSession } from '../../lib/session';

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
};

type ExchangeAccount = { id: string; exchange: string; label: string; marketType: string; tradingEnabled: boolean; credentialStatus: string };
type Market = { symbol: string; base: string; quote: string; type: string; active: boolean };
type BotSummary = {
  id: string;
  name: string;
  type: string;
  status: BotStatus;
  activeVersion: number;
  config: BotConfig;
  createdAt: string;
  updatedAt: string;
  exchangeAccount: { exchange: string; label: string };
};
type BotVersion = { id: string; version: number; config: BotConfig; checksum: string; createdAt: string };
type BotRun = { id: string; startedAt: string; stoppedAt: string | null; status: string; metrics: Record<string, unknown> };
type BotDetail = BotSummary & { exchangeAccount: { exchange: string; label: string; marketType: string }; versions: BotVersion[]; runs: BotRun[] };

type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;
type EditTarget = { id: string; name: string; config: BotConfig };

const ACTION_OPTIONS = ['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'REVERSE', 'PARTIAL_EXIT'] as const;
const ALLOCATION_OPTIONS = ['NONE', 'PERCENT_EQUITY', 'PERCENT_MAX_EQUITY', 'FIXED_AMOUNT', 'RISK_PERCENT'] as const;

const STATUS_TONES: Record<BotStatus, string> = { ACTIVE: 'ok', PAUSED: 'warn', STOPPED: 'muted', ERROR: 'bad', DRAFT: 'muted' };

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  return parts.join(' · ');
}

function SymbolPicker({ accounts, selected, onChange }: { accounts: ExchangeAccount[]; selected: string[]; onChange: (next: string[]) => void }) {
  const [query, setQuery] = useState('');
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    let cancelled = false;
    const session = loadSession();
    if (!session) return;
    Promise.all(
      accounts.map((account) =>
        apiFetch<{ markets: Market[] }>(`/exchange-accounts/${account.id}/markets`, session)
          .then((data) => data.markets)
          .catch(() => [] as Market[])
      )
    )
      .then((lists) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const merged: Market[] = [];
        for (const list of lists) for (const market of list) if (!seen.has(market.symbol)) { seen.add(market.symbol); merged.push(market); }
        merged.sort((a, b) => a.symbol.localeCompare(b.symbol));
        setMarkets(merged);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [accounts]);

  const toggle = (symbol: string) => onChange(selected.includes(symbol) ? selected.filter((item) => item !== symbol) : [...selected, symbol]);
  const queryUpper = query.trim().toUpperCase();
  const known = new Set((markets ?? []).map((market) => market.symbol));
  const matching = (markets ?? []).filter((market) => market.symbol.toUpperCase().includes(queryUpper));
  const orphaned = selected.filter((symbol) => !known.has(symbol));
  const addMatches = () => onChange([...selected, ...matching.map((market) => market.symbol).filter((symbol) => !selected.includes(symbol))]);
  const addAll = () => onChange([...selected, ...(markets ?? []).map((market) => market.symbol).filter((symbol) => !selected.includes(symbol))]);
  const addCustom = () => {
    const trimmed = custom.trim().toUpperCase();
    if (trimmed && !selected.includes(trimmed)) onChange([...selected, trimmed]);
    setCustom('');
  };

  return (
    <label className="symbol-picker">
      <span>Symbols — {selected.length} selected {accounts.length > 1 ? `(from ${accounts.length} accounts)` : ''}</span>
      <div className="symbol-tools">
        <input className="symbol-search" onChange={(event) => setQuery(event.target.value)} placeholder="Search pairs (BTC, ETH, DOGE…)" type="search" value={query} />
        <div className="symbol-actions">
          <button disabled={!queryUpper} onClick={addMatches} type="button">Add all matches</button>
          <button disabled={(markets ?? []).length === 0} onClick={addAll} type="button">Select all</button>
          <button disabled={selected.length === 0} onClick={() => onChange([])} type="button">Clear</button>
        </div>
      </div>
      <div className="symbol-list">
        {!markets && <p className="muted small">Loading markets from your verified accounts…</p>}
        {markets && markets.length === 0 && <p className="muted small">No markets returned by the exchange.</p>}
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
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [email, setEmail] = useState('cert@example.com');
  const [password, setPassword] = useState('');
  const [submittingLogin, setSubmittingLogin] = useState(false);
  const [accounts, setAccounts] = useState<ExchangeAccount[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selected, setSelected] = useState<BotDetail | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const stored = loadSession();
    setSession(stored);
    setBooting(false);
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await apiFetch<ExchangeAccount[]>('/exchange-accounts', loadSession());
      setAccounts(data.filter((account) => account.tradingEnabled && account.credentialStatus === 'VERIFIED'));
    } catch {
      setNotice({ tone: 'info', message: 'Could not load exchange accounts.' });
    }
  }, []);

  const loadBots = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<BotSummary[]>('/bots', loadSession());
      setBots(data);
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 401) {
        clearSession();
        setSession(null);
        setNotice({ tone: 'error', message: 'Session expired — sign in again.' });
      } else {
        setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load bots.' });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (botId: string) => {
    try {
      setSelected(await apiFetch<BotDetail>(`/bots/${botId}`, loadSession()));
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load bot detail.' });
    }
  }, []);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmittingLogin(true);
    try {
      const nextSession = await login(email, password);
      setSession(nextSession);
      setNotice({ tone: 'success', message: `Signed in as ${nextSession.user.email}.` });
      void loadAccounts();
      void loadBots();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Login failed.' });
    } finally {
      setSubmittingLogin(false);
    }
  };

  const logout = () => {
    clearSession();
    setSession(null);
    setBots([]);
    setSelected(null);
    setNotice(null);
  };

  const openCreate = () => {
    setEditTarget(null);
    setSymbols([]);
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

    try {
      if (editTarget) {
        await apiFetch(`/bots/${editTarget.id}/config`, loadSession(), { method: 'PATCH', body: { config } });
        setNotice({ tone: 'success', message: `Bot "${editTarget.name}" updated (new version created).` });
      } else {
        const accountId = String(form.get('exchangeAccountId') ?? '');
        const name = String(form.get('name') ?? '').trim();
        const bot = await apiFetch<BotSummary>('/bots', loadSession(), { method: 'POST', body: { name, exchangeAccountId: accountId, config } });
        setNotice({ tone: 'success', message: `Bot "${bot.name}" created and ACTIVE.` });
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
      await apiFetch(`/bots/${bot.id}/${action}`, loadSession(), { method: 'POST', body: {} });
      const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'stopped';
      setNotice({ tone: 'success', message: `Bot "${bot.name}" ${verb}.` });
      await loadBots();
      if (selected?.id === bot.id) void loadDetail(bot.id);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Status change failed.' });
    }
  };

  if (booting) {
    return <main className="shell center-shell"><p className="muted">Loading sessions…</p></main>;
  }

  if (!session) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="login-brand">
            <NexusLogo className="brand-logo" />
            <div><b>NexusTrade</b><small>Bots console</small></div>
          </div>
          <h1>Sign in</h1>
          <p className="muted">Authenticate to manage webhook trading bots.</p>
          <form onSubmit={handleLogin}>
            <label>Email<input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
            <label>Password<input autoComplete="current-password" minLength={8} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
            <button className="primary" disabled={submittingLogin} type="submit">{submittingLogin ? 'Signing in…' : 'Sign in'}</button>
          </form>
          {notice && <div className={`notice-bar ${notice.tone}`} role="status"><span>{notice.message}</span><button aria-label="Dismiss" onClick={() => setNotice(null)} type="button"><X size={16} /></button></div>}
          <p className="muted small">Demo: cert@example.com / supersecret123</p>
        </section>
      </main>
    );
  }

  const prefill = editTarget?.config;

  return (
    <main className="shell">
      <aside>
        <Link className="brand brand-button" href="/">
          <NexusLogo className="brand-logo" />
          <span><b>NexusTrade</b><small>Bots console</small></span>
        </Link>
        <nav aria-label="Bot console navigation">
          <Link className="nav-link" href="/dashboard"><LayoutDashboard size={15} /> Dashboard</Link>
          <button className="active" type="button">Bots</button>
        </nav>
        <div className="security user-card">
          <ShieldCheck size={18} />
          <span><b>{session.user.email}</b><small>{session.workspace?.name ?? 'My workspace'}</small></span>
        </div>
        <button className="logout" onClick={logout} type="button"><LogOut size={16} /> Sign out</button>
      </aside>

      <section className="content">
        <header>
          <div>
            <p className="eyebrow">AUTOMATED TRADING</p>
            <h1>Bots</h1>
            <p className="muted">TradingView webhook bots route signals to live exchange orders.</p>
          </div>
          <button className="primary" onClick={openCreate} type="button"><CirclePlus size={17} /> New bot</button>
        </header>

        {notice && (
          <div className={`notice-bar ${notice.tone}`} role="status">
            <span>{notice.message}</span>
            <button aria-label="Dismiss notification" onClick={() => setNotice(null)} type="button"><X size={16} /></button>
          </div>
        )}

        <div className="bot-layout">
          <article className="bot-list-card">
            <div className="card-head">
              <div><p>WORKSPACE BOTS</p><h2>{bots.length} configured</h2></div>
              <button className="secondary" disabled={loading} onClick={() => void loadBots()} type="button"><RefreshCw size={14} /> Refresh</button>
            </div>
            <div className="table-scroll">
              {!loading && bots.length === 0 && <p className="muted empty">No bots yet — create one to connect a TradingView webhook.</p>}
              {bots.length > 0 && (
                <table>
                  <thead><tr><th>Bot</th><th>Account</th><th>Status</th><th>Version</th><th>Config</th><th>Actions</th></tr></thead>
                  <tbody>
                    {bots.map((bot) => (
                      <tr className={selected?.id === bot.id ? 'selected-row' : ''} key={bot.id} onClick={() => void loadDetail(bot.id)}>
                        <td><b>{bot.name}</b><small className="muted block">{bot.type}</small></td>
                        <td>{bot.exchangeAccount.label}<small className="muted block">{bot.exchangeAccount.exchange}</small></td>
                        <td><span className={`status-label ${STATUS_TONES[bot.status]}`}>{bot.status}</span></td>
                        <td>v{bot.activeVersion}</td>
                        <td className="config-cell" title={formatConfig(bot.config)}>{formatConfig(bot.config)}</td>
                        <td className="row-actions" onMouseDown={(event) => event.stopPropagation()}>
                          {bot.status !== 'ACTIVE' && <button className="icon-btn safe" onClick={() => void setBotStatus(bot, 'resume')} title="Resume" type="button"><Play size={14} /></button>}
                          {bot.status === 'ACTIVE' && <button className="icon-btn" onClick={() => void setBotStatus(bot, 'pause')} title="Pause" type="button"><Pause size={14} /></button>}
                          <button className="icon-btn" onClick={() => openEdit(bot)} title="Edit config" type="button"><Settings2 size={14} /></button>
                          {bot.status !== 'STOPPED' && <button className="icon-btn danger" onClick={() => void setBotStatus(bot, 'stop')} title="Stop" type="button"><Square size={14} /></button>}
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
                  <small className="muted">v{selected.activeVersion} · {selected.exchangeAccount.marketType} · {selected.exchangeAccount.label}</small>
                </div>
                <button aria-label="Close detail" className="icon-btn" onClick={() => setSelected(null)} type="button"><X size={16} /></button>
              </div>
              <p className="muted small config-line">{formatConfig(selected.config)}</p>
              <h3>Runs <span className="muted">(last {selected.runs.length})</span></h3>
              {selected.runs.length === 0 && <p className="muted empty">No runs yet — the worker records a run for every routed webhook signal.</p>}
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
                        {typeof run.metrics.price === 'number' && <span>mark {String(run.metrics.price)}</span>}
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
      </section>

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
                  <label>Trading account (verified + trading enabled)
                    <select name="exchangeAccountId" required>
                      {accounts.length === 0 && <option value="">No verified accounts</option>}
                      {accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.exchange} · {account.marketType}</option>)}
                    </select>
                  </label>
                </>
              )}
              <SymbolPicker accounts={accounts} onChange={setSymbols} selected={symbols} />
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
              <div className="modal-actions">
                <button className="secondary" onClick={() => setCreateOpen(false)} type="button">Cancel</button>
                <button className="primary" disabled={saving} type="submit">{saving ? 'Saving…' : editTarget ? 'Save config' : 'Create bot'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}