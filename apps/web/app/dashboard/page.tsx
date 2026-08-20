'use client';

import { AlertTriangle, Bell, Bot, Boxes, Check, Layers, Power, RefreshCw, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell, { type ShellContext } from '../components/AppShell';
import { ApiHttpError, apiFetch, type AuthSession } from '../../lib/session';

type LedgerPosition = {
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
  since: string;
  positions: LedgerPosition[];
  realizedBySymbol: RealizedRow[];
  totals: { unrealized: string; realized: string; openPositions: number; ledgerRows: number };
  generatedAt: string;
  live: boolean;
};

type ExecutionRow = {
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
  mcpUrl: string;
  tradingEnabled: boolean;
  liveTradingAcknowledgedAt: string | null;
  dailyLossLimit: string | null;
  dailyRealizedPnl: string;
  breakerTripped: boolean;
  breakerReason: string | null;
};

const WINDOWS = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 7 * 24 },
  { label: '30d', hours: 30 * 24 },
  { label: 'All time', hours: null },
] as const;

const EXEC_STATE_TONES: Record<string, string> = { FILLED: 'ok', QUEUED: 'ok', RECEIVED: 'muted', REJECTED: 'bad', CANCELED: 'muted', FAILED: 'bad', EXPIRED: 'muted' };

function formatTime(iso: string | null): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value: string, digits = 2): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  return amount.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatPnl(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '$0.00';
  return `${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlClass(value: string): string {
  const amount = Number(value);
  return amount > 0 ? 'profit' : amount < 0 ? 'loss' : 'muted';
}

function mcpUrl(endpoint: string): string {
  return endpoint;
}

export default function DashboardPage() {
  return (
    <AppShell active="dashboard">
      {({ session, setNotice, signOut }) => <DashboardBody session={session} setNotice={setNotice} signOut={signOut} />}
    </AppShell>
  );
}

function DashboardBody({ session, setNotice, signOut }: { session: AuthSession; setNotice: ShellContext['setNotice']; signOut: ShellContext['signOut'] }) {
  const [loading, setLoading] = useState(false);
  const [windowHours, setWindowHours] = useState<number | null>(7 * 24);
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [workspaceRisk, setWorkspaceRisk] = useState<WorkspaceRisk | null>(null);
  const [limitInput, setLimitInput] = useState('');
  const [riskBusy, setRiskBusy] = useState(false);

  const loadNotifications = useCallback(async () => {
    try {
      const [list, count] = await Promise.all([
        apiFetch<{ notifications: AppNotification[] }>('/api/notifications', session),
        apiFetch<{ count: number }>('/api/notifications/unread/count', session),
      ]);
      setNotifications(list.notifications);
      setUnread(count.count);
    } catch {
      /* notifications are non-critical */
    }
  }, [session]);

  const loadWorkspaceRisk = useCallback(async () => {
    try {
      const risk = await apiFetch<WorkspaceRisk>('/api/settings', session);
      setWorkspaceRisk(risk);
      setLimitInput(risk.dailyLossLimit ?? '');
    } catch {
      /* risk panel is non-critical */
    }
  }, [session]);

  const toggleTrading = async (enabled: boolean) => {
    if (riskBusy) return;
    if (!enabled && !window.confirm('Kill live trading? New orders and bot runs will be blocked. Open positions are NOT closed automatically.')) return;
    setRiskBusy(true);
    try {
      const updated = await apiFetch<{ tradingEnabled: boolean; liveTradingAcknowledgedAt: string | null }>('/api/settings', session, { method: 'PATCH', body: { tradingEnabled: enabled } });
      setWorkspaceRisk((risk) => (risk ? { ...risk, tradingEnabled: updated.tradingEnabled, liveTradingAcknowledgedAt: updated.liveTradingAcknowledgedAt } : risk));
      setNotice({ tone: 'success', message: enabled ? 'Live trading resumed.' : 'Live trading KILLED — new orders and bot runs are blocked.' });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not toggle trading.' });
    } finally {
      setRiskBusy(false);
    }
  };

  const saveLossLimit = async () => {
    if (riskBusy) return;
    const value = limitInput.trim();
    const dailyLossLimit = value === '' ? null : Number(value);
    if (dailyLossLimit !== null && (!Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0)) {
      setNotice({ tone: 'error', message: 'Daily loss limit must be a positive number (empty clears it).' });
      return;
    }
    setRiskBusy(true);
    try {
      const updated = await apiFetch<{ dailyLossLimit: string | null }>('/api/settings', session, { method: 'PATCH', body: { dailyLossLimit } });
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
    if (riskBusy) return;
    if (!window.confirm('Place market reduce-only orders to close ALL open positions? This cannot be undone by the system.')) return;
    setRiskBusy(true);
    try {
      const result = await apiFetch<{ accepted: boolean; operation: string }>('/api/orders/emergency/close-all', session, { method: 'POST', body: {} });
      setNotice({ tone: 'info', message: `Close-all submitted (${result.operation ?? 'ok'}).` });
      await loadAll(windowHours);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not submit close-all.' });
    } finally {
      setRiskBusy(false);
    }
  };

  const loadAll = useCallback(
    async (hours: number | null, silent = false) => {
      if (!silent) setLoading(true);
      const since = `${hours === null ? '2000-01-01T00:00:00.000Z' : new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()}`;
      try {
        const [pnlResponse, execResponse] = await Promise.all([
          apiFetch<PnlResponse>(`/api/portfolio/pnl?since=${encodeURIComponent(since)}`, session),
          apiFetch<{ executions: ExecutionRow[] }>('/api/portfolio/executions?take=60', session),
        ]);
        setPnl(pnlResponse);
        setExecutions(execResponse.executions);
      } catch (error) {
        if (error instanceof ApiHttpError && error.status === 401) {
          signOut();
          setNotice({ tone: 'error', message: 'Session expired — sign in again.' });
        } else {
          setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load dashboard data.' });
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [session, setNotice, signOut],
  );

  useEffect(() => {
    void loadAll(windowHours);
    void loadNotifications();
    void loadWorkspaceRisk();
  }, [windowHours, loadAll, loadNotifications, loadWorkspaceRisk]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadAll(windowHours, true);
      void loadNotifications();
      void loadWorkspaceRisk();
    }, 15000);
    return () => clearInterval(timer);
  }, [windowHours, loadAll, loadNotifications, loadWorkspaceRisk]);

  const markRead = async (notification: AppNotification) => {
    if (notification.readAt) return;
    try {
      await apiFetch(`/api/notifications/${notification.id}/read`, session, { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item)));
      setUnread((count) => Math.max(0, count - 1));
    } catch {
      setNotice({ tone: 'info', message: 'Could not mark notification as read.' });
    }
  };

  const markAllRead = async () => {
    if (unread === 0) return;
    try {
      await apiFetch('/api/notifications/read-all', session, { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.readAt ? item : { ...item, readAt: new Date().toISOString() })));
      setUnread(0);
    } catch {
      setNotice({ tone: 'info', message: 'Could not mark notifications as read.' });
    }
  };

  const totals = pnl?.totals;
  const activePositions = pnl?.positions.filter((position) => Number(position.quantity) !== 0) ?? [];
  const lastUpdated = pnl?.generatedAt ? new Date(pnl.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">PORTFOLIO MONITORING</p>
          <h1>Dashboard</h1>
          <p className="muted">Realized and unrealized PnL from the fill-driven ledger, plus recent activity.</p>
        </div>
        <button className="secondary" disabled={loading} onClick={() => void loadAll(windowHours)} type="button">
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      <div className="risk-card">
        <div className="risk-summary">
          <div className="risk-icon">
            <AlertTriangle size={18} />
          </div>
          <div>
            <p>Risk controls</p>
            <h3>
              <span className={`status-label ${workspaceRisk?.tradingEnabled ? 'ok' : 'bad'}`}>{workspaceRisk?.tradingEnabled ? 'TRADING LIVE' : 'TRADING KILLED'}</span>
              {workspaceRisk?.breakerTripped && <span className="status-label bad">BREAKER TRIPPED</span>}
            </h3>
            <small className="muted">
              Daily realized: <b className={workspaceRisk && Number(workspaceRisk.dailyRealizedPnl) < 0 ? 'loss' : 'profit'}>{formatPnl(workspaceRisk?.dailyRealizedPnl ?? '0')}</b>
              {' — '}Limit: {workspaceRisk?.dailyLossLimit ? `$${formatNumber(workspaceRisk.dailyLossLimit)}` : 'off'}
            </small>
          </div>
        </div>
        <div className="risk-actions">
          {workspaceRisk?.tradingEnabled ? (
            <button className="danger" disabled={riskBusy} onClick={() => void toggleTrading(false)} type="button">
              <Power size={14} /> Kill trading
            </button>
          ) : (
            <button className="primary" disabled={riskBusy} onClick={() => void toggleTrading(true)} type="button">
              <Power size={14} /> Resume trading
            </button>
          )}
          <button className="secondary" disabled={riskBusy} onClick={() => void closeAllPositions()} type="button">
            <Layers size={14} /> Close all positions
          </button>
          <label className="limit-row">
            <span className="muted small">Daily loss limit USDT</span>
            <input onChange={(event) => setLimitInput(event.target.value)} placeholder="e.g. 50 (empty = off)" type="number" value={limitInput} />
            <button className="secondary" disabled={riskBusy} onClick={() => void saveLossLimit()} type="button">
              Set
            </button>
          </label>
        </div>
      </div>

      {workspaceRisk?.mcpUrl && (
        <div className="mcp-card">
          <div className="risk-summary">
            <div className="risk-icon">
              <Bot size={18} />
            </div>
            <div>
              <p>AI agent endpoint (MCP)</p>
              <h3>{mcpUrl(workspaceRisk.mcpUrl)}</h3>
              <small className="muted">Connect any AI agent (Claude, Cursor, opencode, etc.) to this URL — send the password as <code>Authorization: Bearer &lt;password&gt;</code>. The password is configured via the MCP_PASSWORD environment variable.</small>
            </div>
          </div>
          <div className="risk-actions">
            <button
              className="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(mcpUrl(workspaceRisk.mcpUrl)).catch(() => undefined);
                setNotice({ tone: 'success', message: 'MCP endpoint copied.' });
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
        <span className="muted small">{pnl ? `since ${formatTime(pnl.since)}` : 'loading…'}</span>
        <span className="muted small">
          {pnl?.live ? <span className="status-label ok">LIVE</span> : <span className="status-label warn">CACHED</span>}
          {lastUpdated ? ` · updated ${lastUpdated}` : ''}
        </span>
      </div>

      <div className="grid metrics">
        <article>
          <div className="icon">
            <TrendingUp size={19} />
          </div>
          <p>Realized PnL (window)</p>
          <h2 className={totals ? pnlClass(totals.realized) : ''}>{totals ? formatPnl(totals.realized) : '…'}</h2>
          <small>{pnl?.realizedBySymbol.length ?? 0} symbols settled</small>
        </article>
        <article>
          <div className="icon">
            <Layers size={19} />
          </div>
          <p>Unrealized PnL</p>
          <h2 className={totals ? pnlClass(totals.unrealized) : ''}>{totals ? formatPnl(totals.unrealized) : '…'}</h2>
          <small>{totals?.openPositions ?? 0} open positions</small>
        </article>
        <article>
          <div className="icon">
            <Boxes size={19} />
          </div>
          <p>Open positions</p>
          <h2>{totals?.openPositions ?? '…'}</h2>
          <small>{activePositions.length} active / {totals?.ledgerRows ?? 0} ledger rows</small>
        </article>
        <article>
          <div className="icon">
            <Bell size={19} />
          </div>
          <p>Notifications</p>
          <h2>{unread}</h2>
          <small>{unread === 0 ? 'all read' : 'unread'}</small>
        </article>
      </div>

      <div className="grid lower">
        <article>
          <div className="card-head">
            <div>
              <p>Ledger</p>
              <h3>Open positions & live PnL</h3>
            </div>
            <span className="muted small">{activePositions.length} open · {formatPnl(totals?.realized ?? '0')} realized — {formatPnl(totals?.unrealized ?? '0')} unrealized</span>
          </div>
          <div className="table-scroll">
            {!loading && pnl && pnl.positions.length === 0 && <p className="muted empty">No open positions — closed positions are settled and removed from this view.</p>}
            {pnl && pnl.positions.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Qty</th>
                    <th>Entry</th>
                    <th>Mark</th>
                    <th>Realized</th>
                    <th>Unrealized</th>
                    <th>Lev</th>
                    <th>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.positions.map((position) => (
                    <tr key={`${position.symbol}:${position.side}`}>
                      <td>
                        <b>{position.symbol}</b>
                      </td>
                      <td>
                        <span className={`status-label ${position.side === 'SHORT' ? 'bad' : 'ok'}`}>{position.side}</span>
                      </td>
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
            <div>
              <p>Realized by symbol</p>
              <h3>{pnl?.realizedBySymbol.length ?? 0} symbols</h3>
            </div>
          </div>
          <div className="activity">
            {!loading && pnl && pnl.realizedBySymbol.length === 0 && <p className="muted empty">No fills settled in this window.</p>}
            {pnl?.realizedBySymbol.map((row) => (
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
            <div>
              <p>Activity</p>
              <h3>Order & execution history</h3>
            </div>
            <span className="muted small">{executions.length} rows</span>
          </div>
          <div className="table-scroll">
            {!loading && executions.length === 0 && <p className="muted empty">No orders yet — place an order or trigger a bot run to record activity.</p>}
            {executions.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>State</th>
                    <th>Side</th>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((row) => (
                    <tr key={`${row.orderId}-${row.executionId ?? 'nofill'}`}>
                      <td>{formatTime(row.executedAt ?? row.createdAt)}</td>
                      <td>
                        <span className={`status-label ${EXEC_STATE_TONES[row.state] ?? 'muted'}`}>{row.state}</span>
                      </td>
                      <td>
                        <span className={row.side === 'BUY' ? 'long' : 'short'}>{row.side}</span>
                        {row.positionSide !== 'BOTH' && <small className="muted block">{row.positionSide}</small>}
                      </td>
                      <td>
                        <b>{row.symbol}</b>
                        {row.marketType && <small className="muted block">{row.marketType === 'SPOT' ? 'Spot' : 'Futures'}</small>}
                      </td>
                      <td>{formatNumber(row.quantity)}</td>
                      <td>{row.price ? formatNumber(row.price, 6) : '…'}</td>
                      <td>{row.fee ? `${formatNumber(row.fee, 6)} ${row.feeAsset ?? ''}` : '…'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </article>

        <article>
          <div className="card-head">
            <div>
              <p>Live alerts</p>
              <h3>
                Notifications {unread > 0 && <span className="badge">{unread}</span>}
              </h3>
            </div>
            <button className="secondary" disabled={unread === 0} onClick={() => void markAllRead()} type="button">
              Mark all read
            </button>
          </div>
          <div className="notification-list">
            {!loading && notifications.length === 0 && <p className="muted empty">No notifications yet.</p>}
            {notifications.map((notification) => (
              <div className={`notification-item ${notification.readAt ? '' : 'unread'}`} key={notification.id}>
                <div className="notification-head">
                  <span className={`severity-dot ${notification.severity.toLowerCase()}`} />
                  <b>{notification.title}</b>
                  {!notification.readAt && (
                    <button aria-label="Mark as read" className="icon-btn" onClick={() => void markRead(notification)} type="button">
                      <Check size={13} />
                    </button>
                  )}
                </div>
                {notification.message && <p className="muted small">{notification.message}</p>}
                <em className="muted small">{notification.channel} / {formatTime(notification.createdAt)}</em>
              </div>
            ))}
          </div>
        </article>
      </div>
    </>
  );
}
