'use client';

import { AlertTriangle, Bell, Bot, Boxes, Check, Home, Layers, LayoutDashboard, LogOut, Power, RefreshCw, ShieldCheck, TrendingUp, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { NexusLogo } from '../logo';
import { ApiHttpError, apiFetch, clearSession, loadSession, login, type AuthSession } from '../../lib/session';

type LedgerPosition = {
  accountId: string;
  exchange: string;
  marketType: string;
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

type RealizedRow = { symbol: string; realizedPnl: string; fills: number };

type PnlResponse = {
  windowStart: string;
  positions: LedgerPosition[];
  realized: RealizedRow[];
  totals: { unrealizedPnl: string; realizedPnl: string; openPositions: number; ledgerRows: number };
  generatedAt: string;
};

type ExecutionRow = {
  orderId: string;
  state: string;
  side: string;
  positionSide: string;
  symbol: string;
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

type AppNotification = {
  id: string;
  channel: string;
  severity: string;
  title: string;
  message?: string | null;
  payload?: unknown;
  readAt: string | null;
  createdAt: string;
};

type WorkspaceRisk = {
  handle: string;
  mcpEndpoint: string;
  liveTradingEnabled: boolean;
  liveTradingAcknowledgedAt: string | null;
  dailyLossLimit: string | null;
  dailyRealizedPnl: string;
  circuitBreaker: boolean;
};

type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;

const WINDOWS = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 7 * 24 },
  { label: '30d', hours: 30 * 24 },
  { label: 'All time', hours: null },
] as const;

const EXEC_STATE_TONES: Record<string, string> = { FILLED: 'ok', QUEUED: 'ok', RECEIVED: 'muted', REJECTED: 'bad', CANCELED: 'muted', FAILED: 'bad', EXPIRED: 'muted' };

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value: string, digits = 2): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatPnl(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '$0.00';
  return `${amount >= 0 ? '+' : '−'}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlClass(value: string): string {
  const amount = Number(value);
  return amount > 0 ? 'profit' : amount < 0 ? 'loss' : 'muted';
}

export default function Dashboard() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [email, setEmail] = useState('cert@example.com');
  const [password, setPassword] = useState('');
  const [submittingLogin, setSubmittingLogin] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(false);
  const [windowHours, setWindowHours] = useState<number | null>(7 * 24);
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [workspaceRisk, setWorkspaceRisk] = useState<WorkspaceRisk | null>(null);
  const [limitInput, setLimitInput] = useState('');
  const [riskBusy, setRiskBusy] = useState(false);

  useEffect(() => {
    const stored = loadSession();
    setSession(stored);
    setBooting(false);
  }, []);

  const loadNotifications = useCallback(async (activeSession: AuthSession) => {
    try {
      const [list, count] = await Promise.all([
        apiFetch<AppNotification[]>('/notifications', activeSession),
        apiFetch<{ count: number }>('/notifications/unread/count', activeSession),
      ]);
      setNotifications(list);
      setUnread(count.count);
    } catch {
      /* notifications are non-critical */
    }
  }, []);

  const reloadNotifications = useCallback(async () => {
    const current = loadSession();
    if (current) await loadNotifications(current);
  }, [loadNotifications]);

  const loadWorkspaceRisk = useCallback(async (activeSession: AuthSession) => {
    try {
      const risk = await apiFetch<WorkspaceRisk>('/workspaces/me', activeSession);
      setWorkspaceRisk(risk);
      setLimitInput(risk.dailyLossLimit ?? '');
    } catch {
      /* risk panel is non-critical */
    }
  }, []);

  const toggleTrading = async (enabled: boolean) => {
    if (!session || riskBusy) return;
    if (!enabled && !window.confirm('Kill live trading for this workspace? New orders and bot runs will be blocked. Open positions are NOT closed automatically.')) return;
    setRiskBusy(true);
    try {
      const updated = await apiFetch<{ liveTradingEnabled: boolean; dailyLossLimit: string | null }>('/workspaces/me', session, { method: 'PATCH', body: { enabled } });
      setWorkspaceRisk((risk) => (risk ? { ...risk, liveTradingEnabled: updated.liveTradingEnabled, dailyLossLimit: updated.dailyLossLimit } : risk));
      setNotice({ tone: 'success', message: enabled ? 'Live trading resumed.' : 'Live trading KILLED — new orders and bot runs are blocked.' });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not toggle trading.' });
    } finally {
      setRiskBusy(false);
    }
  };

  const saveLossLimit = async () => {
    if (!session || riskBusy) return;
    const value = limitInput.trim();
    const dailyLossLimit = value === '' ? null : Number(value);
    if (dailyLossLimit !== null && (!Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0)) {
      setNotice({ tone: 'error', message: 'Daily loss limit must be a positive number (empty clears it).' });
      return;
    }
    setRiskBusy(true);
    try {
      const updated = await apiFetch<{ liveTradingEnabled: boolean; dailyLossLimit: string | null }>('/workspaces/me', session, { method: 'PATCH', body: { dailyLossLimit } });
      setWorkspaceRisk((risk) => (risk ? { ...risk, dailyLossLimit: updated.dailyLossLimit } : risk));
      setLimitInput(updated.dailyLossLimit ?? '');
      setNotice({ tone: 'success', message: dailyLossLimit === null ? 'Daily loss limit cleared.' : `Daily loss limit set to $${dailyLossLimit}.` });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not update loss limit.' });
    } finally {
      setRiskBusy(false);
    }
  };

  const closeAllPositions = async () => {
    if (!session || riskBusy) return;
    if (!window.confirm('Place market reduce-only orders to close ALL positions across every exchange account? This cannot be undone by the system.')) return;
    setRiskBusy(true);
    try {
      const result = await apiFetch<{ accepted: boolean; operation: string; exchangeAccountIds: string[] }>('/orders/emergency/close-all', session, { method: 'POST', body: {} });
      setNotice({ tone: 'info', message: `Close-all submitted for ${result.exchangeAccountIds.length} account(s).` });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not submit close-all.' });
    } finally {
      setRiskBusy(false);
    }
  };

  const loadAll = useCallback(async (active: AuthSession | null, hours: number | null) => {
    const current = active ?? loadSession();
    if (!current) return;
    setLoading(true);
    const since = `${hours === null ? '2000-01-01T00:00:00.000Z' : new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()}`;
    try {
      const [pnlResponse, execResponse] = await Promise.all([
        apiFetch<PnlResponse>(`/portfolio/pnl?since=${encodeURIComponent(since)}`, current),
        apiFetch<ExecutionRow[]>('/portfolio/executions?take=60', current),
      ]);
      setPnl(pnlResponse);
      setExecutions(execResponse);
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 401) {
        clearSession();
        setSession(null);
        setNotice({ tone: 'error', message: 'Session expired — sign in again.' });
      } else {
        setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load dashboard data.' });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadAll(session, windowHours);
    void reloadNotifications();
    void loadWorkspaceRisk(session);
  }, [session, windowHours, loadAll, reloadNotifications, loadWorkspaceRisk]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmittingLogin(true);
    try {
      const nextSession = await login(email, password);
      setSession(nextSession);
      setNotice({ tone: 'success', message: `Signed in as ${nextSession.user.email}.` });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Login failed.' });
    } finally {
      setSubmittingLogin(false);
    }
  };

  const logout = () => {
    clearSession();
    setSession(null);
    setPnl(null);
    setExecutions([]);
    setNotifications([]);
    setNotice(null);
  };

  const markRead = async (notification: AppNotification) => {
    if (!session || notification.readAt) return;
    try {
      await apiFetch(`/notifications/${notification.id}/read`, session, { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item)));
      setUnread((count) => Math.max(0, count - 1));
    } catch {
      setNotice({ tone: 'info', message: 'Could not mark notification as read.' });
    }
  };

  const markAllRead = async () => {
    if (!session || unread === 0) return;
    try {
      await apiFetch('/notifications/read-all', session, { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.readAt ? item : { ...item, readAt: new Date().toISOString() })));
      setUnread(0);
    } catch {
      setNotice({ tone: 'info', message: 'Could not mark notifications as read.' });
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
            <div><b>NexusTrade</b><small>Live dashboard</small></div>
          </div>
          <h1>Sign in</h1>
          <p className="muted">Authenticate to view portfolio PnL, positions and activity.</p>
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

  const totals = pnl?.totals;
  const activePositions = pnl?.positions.filter((position) => Number(position.quantity) !== 0) ?? [];

  return (
    <main className="shell">
      <aside>
        <Link className="brand brand-button" href="/">
          <NexusLogo className="brand-logo" />
          <span><b>NexusTrade</b><small>Live monitoring</small></span>
        </Link>
        <nav aria-label="Dashboard navigation">
          <Link className="nav-link active" href="/dashboard"><LayoutDashboard size={15} /> Dashboard</Link>
          <Link className="nav-link" href="/bots"><Bot size={15} /> Bots</Link>
          <Link className="nav-link" href="/"><Home size={15} /> Home</Link>
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
            <p className="eyebrow">PORTFOLIO MONITORING</p>
            <h1>Dashboard</h1>
            <p className="muted">Realized and unrealized PnL from the fill-driven ledger, plus recent activity.</p>
          </div>
          <button className="secondary" disabled={loading} onClick={() => void loadAll(session, windowHours)} type="button"><RefreshCw size={14} /> Refresh</button>
        </header>

        {notice && (
          <div className={`notice-bar ${notice.tone}`} role="status">
            <span>{notice.message}</span>
            <button aria-label="Dismiss notification" onClick={() => setNotice(null)} type="button"><X size={16} /></button>
          </div>
        )}

        <div className="risk-card">
          <div className="risk-summary">
            <div className="risk-icon"><AlertTriangle size={18} /></div>
            <div>
              <p>Risk controls</p>
              <h3>
                <span className={`status-label ${workspaceRisk?.liveTradingEnabled ? 'ok' : 'bad'}`}>{workspaceRisk?.liveTradingEnabled ? 'TRADING LIVE' : 'TRADING KILLED'}</span>
                {workspaceRisk && !workspaceRisk.circuitBreaker && <span className="status-label bad">BREAKER TRIPPED</span>}
              </h3>
              <small className="muted">
                Daily realized: <b className={workspaceRisk && Number(workspaceRisk.dailyRealizedPnl) < 0 ? 'loss' : 'profit'}>{formatPnl(workspaceRisk?.dailyRealizedPnl ?? '0')}</b>
                {' · '}Limit: {workspaceRisk?.dailyLossLimit ? `$${formatNumber(workspaceRisk.dailyLossLimit)}` : 'off'}
              </small>
            </div>
          </div>
          <div className="risk-actions">
            {workspaceRisk?.liveTradingEnabled ? (
              <button className="danger" disabled={riskBusy} onClick={() => void toggleTrading(false)} type="button"><Power size={14} /> Kill trading</button>
            ) : (
              <button className="primary" disabled={riskBusy} onClick={() => void toggleTrading(true)} type="button"><Power size={14} /> Resume trading</button>
            )}
            <button className="secondary" disabled={riskBusy} onClick={() => void closeAllPositions()} type="button"><Layers size={14} /> Close all positions</button>
            <label className="limit-row">
              <span className="muted small">Daily loss limit USDT</span>
              <input onChange={(event) => setLimitInput(event.target.value)} placeholder="e.g. 50 (empty = off)" type="number" value={limitInput} />
              <button className="secondary" disabled={riskBusy} onClick={() => void saveLossLimit()} type="button">Set</button>
            </label>
          </div>
        </div>

        {workspaceRisk?.mcpEndpoint && (
          <div className="mcp-card">
            <div className="risk-summary">
              <div className="risk-icon"><Bot size={18} /></div>
              <div>
                <p>AI agent endpoint (MCP)</p>
                <h3>https://&lt;mcp-host&gt;{workspaceRisk.mcpEndpoint}</h3>
                <small className="muted">
                  Connect any AI agent (Claude, Cursor, etc.) with an MCP grant token from <b>POST /api/v1/mcp-clients</b>. Your handle: <b>{workspaceRisk.handle}</b>
                </small>
              </div>
            </div>
            <div className="risk-actions">
              <button
                className="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(`https://<mcp-host>${workspaceRisk.mcpEndpoint}`).catch(() => undefined);
                  setNotice({ tone: 'success', message: 'MCP endpoint copied (replace <mcp-host> with your MCP service URL).' });
                }}
                type="button"
              >
                Copy link
              </button>
            </div>
          </div>
        )}

        <div className="window-tabs" role="tablist" aria-label="PnL window">
          {WINDOWS.map((window) => (
            <button
              aria-selected={windowHours === window.hours}
              className={windowHours === window.hours ? 'active' : ''}
              key={window.label}
              onClick={() => setWindowHours(window.hours)}
              role="tab"
              type="button"
            >
              {window.label}
            </button>
          ))}
          <span className="muted small">{pnl ? `since ${formatTime(pnl.windowStart)}` : 'loading…'}</span>
        </div>

        <div className="grid metrics">
          <article>
            <div className="icon"><TrendingUp size={19} /></div>
            <p>Realized PnL (window)</p>
            <h2 className={totals ? pnlClass(totals.realizedPnl) : ''}>{totals ? formatPnl(totals.realizedPnl) : '—'}</h2>
            <small>{pnl?.realized.length ?? 0} symbols settled</small>
          </article>
          <article>
            <div className="icon"><Layers size={19} /></div>
            <p>Unrealized PnL</p>
            <h2 className={totals ? pnlClass(totals.unrealizedPnl) : ''}>{totals ? formatPnl(totals.unrealizedPnl) : '—'}</h2>
            <small>{totals?.openPositions ?? 0} open positions</small>
          </article>
          <article>
            <div className="icon"><Boxes size={19} /></div>
            <p>Open positions</p>
            <h2>{totals?.openPositions ?? '—'}</h2>
            <small>{activePositions.length} active / {totals?.ledgerRows ?? 0} ledger rows</small>
          </article>
          <article>
            <div className="icon"><Bell size={19} /></div>
            <p>Notifications</p>
            <h2>{unread}</h2>
            <small>{unread === 0 ? 'all read' : 'unread'}</small>
          </article>
        </div>

        <div className="grid lower">
          <article>
            <div className="card-head">
              <div><p>Ledger</p><h3>Open positions & PnL</h3></div>
              <span className="muted small">{formatPnl(totals?.realizedPnl ?? '0')} realized · {formatPnl(totals?.unrealizedPnl ?? '0')} unrealized</span>
            </div>
            <div className="table-scroll">
              {!loading && pnl && pnl.positions.length === 0 && <p className="muted empty">No ledger positions yet — fills are recorded as the worker executes orders.</p>}
              {pnl && pnl.positions.length > 0 && (
                <table>
                  <thead><tr><th>Symbol</th><th>Account</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Realized</th><th>Unrealized</th><th>Lev</th><th>Margin</th></tr></thead>
                  <tbody>
                    {pnl.positions.map((position) => (
                      <tr key={`${position.accountId}:${position.symbol}:${position.side}`}>
                        <td><b>{position.symbol}</b></td>
                        <td>{position.marketType}<small className="muted block">{position.exchange}</small></td>
                        <td><span className={`status-label ${position.side === 'SHORT' ? 'bad' : 'ok'}`}>{position.side}</span></td>
                        <td>{formatNumber(position.quantity)}</td>
                        <td>{formatNumber(position.averageEntryPrice, 6)}</td>
                        <td>{formatNumber(position.markPrice, 6)}</td>
                        <td className={pnlClass(position.realizedPnl)}>{formatPnl(position.realizedPnl)}</td>
                        <td className={pnlClass(position.unrealizedPnl)}>{formatPnl(position.unrealizedPnl)}</td>
                        <td>{position.leverage}x</td>
                        <td className="muted">{position.marginMode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </article>

          <article>
            <div className="card-head">
              <div><p>Realized by symbol</p><h3>{pnl?.realized.length ?? 0} symbols</h3></div>
            </div>
            <div className="activity">
              {!loading && pnl && pnl.realized.length === 0 && <p className="muted empty">No fills settled in this window.</p>}
              {pnl?.realized.map((row) => (
                <p key={row.symbol}>
                  <span className={`dot ${Number(row.realizedPnl) >= 0 ? 'ok' : 'warn'}`} />
                  <b>{row.symbol}</b>
                  <span className={`pnl ${pnlClass(row.realizedPnl)}`}>{formatPnl(row.realizedPnl)}</span>
                  <small>{row.fills} fills in window</small>
                </p>
              ))}
            </div>
          </article>
        </div>

        <div className="grid lower">
          <article>
            <div className="card-head">
              <div><p>Activity</p><h3>Order & execution history</h3></div>
              <span className="muted small">{executions.length} rows</span>
            </div>
            <div className="table-scroll">
              {!loading && executions.length === 0 && <p className="muted empty">No orders yet — place an order or trigger a bot run to record activity.</p>}
              {executions.length > 0 && (
                <table>
                  <thead><tr><th>Time</th><th>State</th><th>Side</th><th>Symbol</th><th>Account</th><th>Qty</th><th>Price</th><th>Fee</th></tr></thead>
                  <tbody>
                    {executions.map((row) => (
                      <tr key={`${row.orderId}-${row.executionId ?? 'nofill'}`}>
                        <td>{formatTime(row.executedAt ?? row.createdAt)}</td>
                        <td><span className={`status-label ${EXEC_STATE_TONES[row.state] ?? 'muted'}`}>{row.state}</span></td>
                        <td><span className={row.side === 'BUY' ? 'long' : 'short'}>{row.side}</span>{row.positionSide !== 'BOTH' && <small className="muted block">{row.positionSide}</small>}</td>
                        <td><b>{row.symbol}</b></td>
                        <td>{row.label}</td>
                        <td>{formatNumber(row.quantity)}</td>
                        <td>{row.price ? formatNumber(row.price, 6) : '—'}</td>
                        <td>{row.fee ? `${formatNumber(row.fee, 6)} ${row.feeAsset ?? ''}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </article>

          <article>
            <div className="card-head">
              <div><p>Live alerts</p><h3>Notifications {unread > 0 && <span className="badge">{unread}</span>}</h3></div>
              <button className="secondary" disabled={unread === 0} onClick={() => void markAllRead()} type="button">Mark all read</button>
            </div>
            <div className="notification-list">
              {!loading && notifications.length === 0 && <p className="muted empty">No notifications yet.</p>}
              {notifications.map((notification) => (
                <div className={`notification-item ${notification.readAt ? '' : 'unread'}`} key={notification.id}>
                  <div className="notification-head">
                    <span className={`severity-dot ${notification.severity.toLowerCase()}`} />
                    <b>{notification.title}</b>
                    {!notification.readAt && <button aria-label="Mark as read" className="icon-btn" onClick={() => void markRead(notification)} type="button"><Check size={13} /></button>}
                  </div>
                  {notification.message && <p className="muted small">{notification.message}</p>}
                  <em className="muted small">{notification.channel} · {formatTime(notification.createdAt)}</em>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}