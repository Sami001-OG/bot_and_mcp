'use client';

import { Boxes, Layers, RefreshCw, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { ApiHttpError, apiFetch } from '../../lib/session';
import { formatNumber, formatPnl, formatTime, pnlClass, STATE_TONES, WINDOWS } from '../../lib/format';
import type { ExecutionRow, PnlResponse } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../../components/ui/Table';
import { TabBar, Tab } from '../../components/ui/Tabs';
import { MetricCard } from '../../components/ui/MetricCard';
import { EmptyState } from '../../components/ui/EmptyState';

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

  const loadAll = useCallback(
    async (hours: number | null, silent = false) => {
      if (!silent) setLoading(true);
      const since = `${hours === null ? '2000-01-01T00:00:00.000Z' : new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()}`;
      try {
        const [pnlResponse, execResponse] = await Promise.all([
          apiFetch<PnlResponse>(`/api/portfolio/pnl?since=${encodeURIComponent(since)}`),
          apiFetch<{ executions: ExecutionRow[] }>('/api/portfolio/executions?take=8'),
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
  }, [windowHours, loadAll]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadAll(windowHours, true);
    }, 15000);
    return () => clearInterval(timer);
  }, [windowHours, loadAll]);

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
                      <Td data-label="Symbol"><b>{position.symbol}</b></Td>
                      <Td data-label="Side"><StatusBadge tone={position.side === 'SHORT' ? 'bad' : 'ok'}>{position.side}</StatusBadge></Td>
                      <Td data-label="Qty">{formatNumber(position.quantity)}</Td>
                      <Td data-label="Entry">{formatNumber(position.averageEntryPrice, 6)}</Td>
                      <Td data-label="Mark">{formatNumber(position.markPrice, 6)}</Td>
                      <Td data-label="Realized" className={pnlClass(position.realizedPnl)}>{formatPnl(position.realizedPnl)}</Td>
                      <Td data-label="Unrealized" className={pnlClass(position.unrealizedPnl)}>{formatPnl(position.unrealizedPnl)}</Td>
                      <Td data-label="Lev">{position.leverage}x</Td>
                      <Td data-label="Margin" className="muted">{position.marginMode}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </TableScroll>
          {pnl && pnl.positions.length > 0 && (
            <div className="mobile-cards">
              {pnl.positions.map((position) => (
                <div className="mc" key={`${position.symbol}:${position.side}`}>
                  <div className="mc-header">
                    <strong>{position.symbol}</strong>
                    <StatusBadge tone={position.side === 'SHORT' ? 'bad' : 'ok'}>{position.side}</StatusBadge>
                  </div>
                  <div className="mc-row"><span className="mc-label">Qty</span><span className="mc-value">{formatNumber(position.quantity)}</span></div>
                  <div className="mc-row"><span className="mc-label">Entry</span><span className="mc-value">{formatNumber(position.averageEntryPrice, 6)}</span></div>
                  <div className="mc-row"><span className="mc-label">Mark</span><span className="mc-value">{formatNumber(position.markPrice, 6)}</span></div>
                  <div className="mc-row"><span className="mc-label">Realized</span><span className={`mc-value ${pnlClass(position.realizedPnl)}`}>{formatPnl(position.realizedPnl)}</span></div>
                  <div className="mc-row"><span className="mc-label">Unrealized</span><span className={`mc-value ${pnlClass(position.unrealizedPnl)}`}>{formatPnl(position.unrealizedPnl)}</span></div>
                  <div className="mc-row"><span className="mc-label">Lev</span><span className="mc-value">{position.leverage}x</span></div>
                  <div className="mc-row"><span className="mc-label">Margin</span><span className="mc-value muted">{position.marginMode}</span></div>
                </div>
              ))}
            </div>
          )}
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

      {executions.length > 0 && (
        <Card>
          <CardHeader eyebrow="Recent activity" title="Latest executions" right={<span className="muted small">{executions.length} rows</span>} />
          <TableScroll>
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
                    <Td data-label="Time">{formatTime(row.executedAt ?? row.createdAt)}</Td>
                    <Td data-label="State"><StatusBadge tone={STATE_TONES[row.state] ?? 'muted'}>{row.state}</StatusBadge></Td>
                    <Td data-label="Side">
                      <span className={row.side === 'BUY' ? 'long' : 'short'}>{row.side}</span>
                      {row.positionSide !== 'BOTH' && <small className="muted block">{row.positionSide}</small>}
                    </Td>
                    <Td data-label="Symbol">
                      <b>{row.symbol}</b>
                      {row.marketType && <small className="muted block">{row.marketType === 'SPOT' ? 'Spot' : 'Futures'}</small>}
                    </Td>
                    <Td data-label="Qty">{formatNumber(row.quantity)}</Td>
                    <Td data-label="Price">{row.price ? formatNumber(row.price, 6) : '…'}</Td>
                    <Td data-label="Fee">{row.fee ? `${formatNumber(row.fee, 6)} ${row.feeAsset ?? ''}` : '…'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
          <div className="mobile-cards">
            {executions.map((row) => (
              <div className="mc" key={`${row.orderId}-${row.executionId ?? 'nofill'}`}>
                <div className="mc-header">
                  <strong>{row.symbol}</strong>
                  <StatusBadge tone={STATE_TONES[row.state] ?? 'muted'}>{row.state}</StatusBadge>
                </div>
                <div className="mc-row"><span className="mc-label">Side</span><span className={`mc-value ${row.side === 'BUY' ? 'long' : 'short'}`}>{row.side}{row.positionSide !== 'BOTH' ? ` ${row.positionSide}` : ''}</span></div>
                <div className="mc-row"><span className="mc-label">Type</span><span className="mc-value">{row.marketType === 'SPOT' ? 'Spot' : 'Futures'}</span></div>
                <div className="mc-row"><span className="mc-label">Qty</span><span className="mc-value">{formatNumber(row.quantity)}</span></div>
                <div className="mc-row"><span className="mc-label">Price</span><span className="mc-value">{row.price ? formatNumber(row.price, 6) : '…'}</span></div>
                {row.fee ? <div className="mc-row"><span className="mc-label">Fee</span><span className="mc-value">{formatNumber(row.fee, 6)} {row.feeAsset ?? ''}</span></div> : null}
                <div className="mc-row"><span className="mc-label">Time</span><span className="mc-value">{formatTime(row.executedAt ?? row.createdAt)}</span></div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}