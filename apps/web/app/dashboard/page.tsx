'use client';

import { AlertTriangle, Bell, Bot, Boxes, Check, Layers, Power, RefreshCw, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { ApiHttpError, apiFetch } from '../../lib/session';
import { formatNumber, formatPnl, formatTime, pnlClass, STATE_TONES, WINDOWS } from '../../lib/format';
import type { AppNotification, ExecutionRow, PnlResponse } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../../components/ui/Table';
import { TabBar, Tab } from '../../components/ui/Tabs';
import { MetricCard } from '../../components/ui/MetricCard';
import { EmptyState } from '../../components/ui/EmptyState';

type WorkspaceRisk = {
  mcpUrl: string;
  tradingEnabled: boolean;
  liveTradingAcknowledgedAt: string | null;
  dailyLossLimit: string | null;
  dailyRealizedPnl: string;
  breakerTripped: boolean;
  breakerReason: string | null;
};

export default function DashboardPage() {
  return (
    <AppShell active="dashboard">
      <DashboardBody />
    </AppShell>
  );
}

function DashboardBody() {
  const { toast, signOut } = useApp();
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
        apiFetch<{ notifications: AppNotification[] }>('/api/notifications'),
        apiFetch<{ count: number }>('/api/notifications/unread/count'),
      ]);
      setNotifications(list.notifications);
      setUnread(count.count);
    } catch {
      /* notifications are non-critical */
    }
  }, []);

  const loadWorkspaceRisk = useCallback(async () => {
    try {
      const risk = await apiFetch<WorkspaceRisk>('/api/settings');
      setWorkspaceRisk(risk);
      setLimitInput(risk.dailyLossLimit ?? '');
    } catch {
      /* risk panel is non-critical */
    }
  }, []);

  const toggleTrading = async (enabled: boolean) => {
    if (riskBusy) return;
    setRiskBusy(true);
    try {
      const updated = await apiFetch<{ tradingEnabled: boolean; liveTradingAcknowledgedAt: string | null }>('/api/settings', { method: 'PATCH', body: { tradingEnabled: enabled } });
      setWorkspaceRisk((risk) => (risk ? { ...risk, tradingEnabled: updated.tradingEnabled, liveTradingAcknowledgedAt: updated.liveTradingAcknowledgedAt } : risk));
      toast('success', enabled ? 'Live trading resumed.' : 'Live trading KILLED — new orders and bot runs are blocked.');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not toggle trading.');
    } finally {
      setRiskBusy(false);
    }
  };

  const saveLossLimit = async () => {
    if (riskBusy) return;
    const value = limitInput.trim();
    const dailyLossLimit = value === '' ? null : Number(value);
    if (dailyLossLimit !== null && (!Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0)) {
      toast('error', 'Daily loss limit must be a positive number (empty clears it).');
      return;
    }
    setRiskBusy(true);
    try {
      const updated = await apiFetch<{ dailyLossLimit: string | null }>('/api/settings', { method: 'PATCH', body: { dailyLossLimit } });
      setWorkspaceRisk((risk) => (risk ? { ...risk, dailyLossLimit: updated.dailyLossLimit } : risk));
      setLimitInput(updated.dailyLossLimit ?? '');
      toast('success', dailyLossLimit === null ? 'Daily loss limit cleared.' : `Daily loss limit set to $${dailyLossLimit}.`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not update loss limit.');
    } finally {
      setRiskBusy(false);
    }
  };

  const closeAllPositions = async () => {
    if (riskBusy) return;
    setRiskBusy(true);
    try {
      const result = await apiFetch<{ accepted: boolean; operation: string }>('/api/orders/emergency/close-all', { method: 'POST', body: {} });
      toast('info', `Close-all submitted (${result.operation ?? 'ok'}).`);
      await loadAll(windowHours);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not submit close-all.');
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
          apiFetch<PnlResponse>(`/api/portfolio/pnl?since=${encodeURIComponent(since)}`),
          apiFetch<{ executions: ExecutionRow[] }>('/api/portfolio/executions?take=60'),
        ]);
        setPnl(pnlResponse);
        setExecutions(execResponse.executions);
      } catch (error) {
        if (error instanceof ApiHttpError && error.status === 401) {
          signOut();
          toast('error', 'Session expired — sign in again.');
        } else {
          toast('error', error instanceof Error ? error.message : 'Failed to load dashboard data.');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [toast, signOut],
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
      await apiFetch(`/api/notifications/${notification.id}/read`, { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item)));
      setUnread((count) => Math.max(0, count - 1));
    } catch {
      toast('info', 'Could not mark notification as read.');
    }
  };

  const markAllRead = async () => {
    if (unread === 0) return;
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.readAt ? item : { ...item, readAt: new Date().toISOString() })));
      setUnread(0);
    } catch {
      toast('info', 'Could not mark notifications as read.');
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
        <Button disabled={loading} onClick={() => void loadAll(windowHours)} variant="secondary">
          <RefreshCw size={14} /> Refresh
        </Button>
      </header>

      <div className="risk-card">
        <div className="risk-summary">
          <div className="risk-icon">
            <AlertTriangle size={18} />
          </div>
          <div>
            <p>Risk controls</p>
            <h3>
              <StatusBadge tone={workspaceRisk?.tradingEnabled ? 'ok' : 'bad'}>{workspaceRisk?.tradingEnabled ? 'TRADING LIVE' : 'TRADING KILLED'}</StatusBadge>
              {workspaceRisk?.breakerTripped && <StatusBadge tone="bad">BREAKER TRIPPED</StatusBadge>}
            </h3>
            <small className="muted">
              Daily realized: <b className={workspaceRisk && Number(workspaceRisk.dailyRealizedPnl) < 0 ? 'loss' : 'profit'}>{formatPnl(workspaceRisk?.dailyRealizedPnl ?? '0')}</b>
              {' — '}Limit: {workspaceRisk?.dailyLossLimit ? `$${formatNumber(workspaceRisk.dailyLossLimit)}` : 'off'}
            </small>
          </div>
        </div>
        <div className="risk-actions">
          {workspaceRisk?.tradingEnabled ? (
            <Button variant="danger" disabled={riskBusy} onClick={() => void toggleTrading(false)}>
              <Power size={14} /> Kill trading
            </Button>
          ) : (
            <Button variant="primary" disabled={riskBusy} onClick={() => void toggleTrading(true)}>
              <Power size={14} /> Resume trading
            </Button>
          )}
          <Button disabled={riskBusy} onClick={() => void closeAllPositions()} variant="secondary">
            <Layers size={14} /> Close all positions
          </Button>
          <label className="limit-row">
            <span className="muted small">Daily loss limit USDT</span>
            <input onChange={(event) => setLimitInput(event.target.value)} placeholder="e.g. 50 (empty = off)" type="number" value={limitInput} />
            <Button disabled={riskBusy} onClick={() => void saveLossLimit()} variant="secondary">
              Set
            </Button>
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
              <h3>{workspaceRisk.mcpUrl}</h3>
              <small className="muted">Connect any AI agent (Claude, Cursor, opencode, etc.) to this URL — send the password as <code>Authorization: Bearer &lt;password&gt;</code>. The password is configured via the MCP_PASSWORD environment variable.</small>
            </div>
          </div>
          <div className="risk-actions">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(workspaceRisk.mcpUrl).catch(() => undefined);
                toast('success', 'MCP endpoint copied.');
              }}
            >
              Copy link
            </Button>
          </div>
        </div>
      )}

      <TabBar ariaLabel="PnL window">
        {WINDOWS.map((window) => (
          <Tab key={window.label} active={windowHours === window.hours} onClick={() => setWindowHours(window.hours)}>
            {window.label}
          </Tab>
        ))}
        <span className="muted small">{pnl ? `since ${formatTime(pnl.since)}` : 'loading…'}</span>
        <span className="muted small">
          {pnl?.live ? <StatusBadge tone="ok">LIVE</StatusBadge> : <StatusBadge tone="warn">CACHED</StatusBadge>}
          {lastUpdated ? ` · updated ${lastUpdated}` : ''}
        </span>
      </TabBar>

      <div className="grid metrics">
        <MetricCard
          icon={<TrendingUp size={19} />}
          label="Realized PnL (window)"
          value={totals ? formatPnl(totals.realized) : '…'}
          valueClass={totals ? pnlClass(totals.realized) : ''}
          sub={`${pnl?.realizedBySymbol.length ?? 0} symbols settled`}
        />
        <MetricCard
          icon={<Layers size={19} />}
          label="Unrealized PnL"
          value={totals ? formatPnl(totals.unrealized) : '…'}
          valueClass={totals ? pnlClass(totals.unrealized) : ''}
          sub={`${totals?.openPositions ?? 0} open positions`}
        />
        <MetricCard
          icon={<Boxes size={19} />}
          label="Open positions"
          value={totals?.openPositions ?? '…'}
          sub={`${activePositions.length} active / ${totals?.ledgerRows ?? 0} ledger rows`}
        />
        <MetricCard
          icon={<Bell size={19} />}
          label="Notifications"
          value={unread}
          sub={unread === 0 ? 'all read' : 'unread'}
        />
      </div>

      <div className="grid lower">
        <Card>
          <CardHeader
            eyebrow="Ledger"
            title="Open positions & live PnL"
            right={<span className="muted small">{activePositions.length} open · {formatPnl(totals?.realized ?? '0')} realized — {formatPnl(totals?.unrealized ?? '0')} unrealized</span>}
          />
          <TableScroll>
            {!loading && pnl && pnl.positions.length === 0 && <EmptyState>No open positions — closed positions are settled and removed from this view.</EmptyState>}
            {pnl && pnl.positions.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <Th>Symbol</Th>
                    <Th>Side</Th>
                    <Th>Qty</Th>
                    <Th>Entry</Th>
                    <Th>Mark</Th>
                    <Th>Realized</Th>
                    <Th>Unrealized</Th>
                    <Th>Lev</Th>
                    <Th>Margin</Th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.positions.map((position) => (
                    <tr key={`${position.symbol}:${position.side}`}>
                      <Td>
                        <b>{position.symbol}</b>
                      </Td>
                      <Td>
                        <StatusBadge tone={position.side === 'SHORT' ? 'bad' : 'ok'}>{position.side}</StatusBadge>
                      </Td>
                      <Td>{formatNumber(position.quantity)}</Td>
                      <Td>{formatNumber(position.averageEntryPrice, 6)}</Td>
                      <Td>{formatNumber(position.markPrice, 6)}</Td>
                      <Td className={pnlClass(position.realizedPnl)}>{formatPnl(position.realizedPnl)}</Td>
                      <Td className={pnlClass(position.unrealizedPnl)}>{formatPnl(position.unrealizedPnl)}</Td>
                      <Td>{position.leverage}x</Td>
                      <Td className="muted">{position.marginMode}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </TableScroll>
        </Card>

        <Card>
          <CardHeader eyebrow="Realized by symbol" title={`${pnl?.realizedBySymbol.length ?? 0} symbols`} />
          <div className="activity">
            {!loading && pnl && pnl.realizedBySymbol.length === 0 && <EmptyState>No fills settled in this window.</EmptyState>}
            {pnl?.realizedBySymbol.map((row) => (
              <p key={row.symbol}>
                <span className={`dot ${Number(row.realizedPnl) >= 0 ? 'ok' : 'warn'}`} />
                <b>{row.symbol}</b>
                <span className={`pnl ${pnlClass(row.realizedPnl)}`}>{formatPnl(row.realizedPnl)}</span>
                <small>{row.fills} fills in window</small>
              </p>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid lower">
        <Card>
          <CardHeader eyebrow="Activity" title="Order & execution history" right={<span className="muted small">{executions.length} rows</span>} />
          <TableScroll>
            {!loading && executions.length === 0 && <EmptyState>No orders yet — place an order or trigger a bot run to record activity.</EmptyState>}
            {executions.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <Th>Time</Th>
                    <Th>State</Th>
                    <Th>Side</Th>
                    <Th>Symbol</Th>
                    <Th>Qty</Th>
                    <Th>Price</Th>
                    <Th>Fee</Th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((row) => (
                    <tr key={`${row.orderId}-${row.executionId ?? 'nofill'}`}>
                      <Td>{formatTime(row.executedAt ?? row.createdAt)}</Td>
                      <Td>
                        <StatusBadge tone={STATE_TONES[row.state] ?? 'muted'}>{row.state}</StatusBadge>
                      </Td>
                      <Td>
                        <span className={row.side === 'BUY' ? 'long' : 'short'}>{row.side}</span>
                        {row.positionSide !== 'BOTH' && <small className="muted block">{row.positionSide}</small>}
                      </Td>
                      <Td>
                        <b>{row.symbol}</b>
                        {row.marketType && <small className="muted block">{row.marketType === 'SPOT' ? 'Spot' : 'Futures'}</small>}
                      </Td>
                      <Td>{formatNumber(row.quantity)}</Td>
                      <Td>{row.price ? formatNumber(row.price, 6) : '…'}</Td>
                      <Td>{row.fee ? `${formatNumber(row.fee, 6)} ${row.feeAsset ?? ''}` : '…'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </TableScroll>
        </Card>

        <Card>
          <CardHeader
            eyebrow="Live alerts"
            title={<>Notifications {unread > 0 && <span className="badge">{unread}</span>}</>}
            right={
              <Button disabled={unread === 0} onClick={() => void markAllRead()} variant="secondary">
                Mark all read
              </Button>
            }
          />
          <div className="notification-list">
            {!loading && notifications.length === 0 && <EmptyState>No notifications yet.</EmptyState>}
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
        </Card>
      </div>
    </>
  );
}