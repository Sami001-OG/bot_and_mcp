'use client';

import { AlertTriangle, Copy, Layers, Power, ShieldCheck, Wallet } from 'lucide-react';
import { useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { apiFetch } from '../../lib/session';
import { formatNumber, formatPnl } from '../../lib/format';
import type { RiskSettings } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { MetricCard } from '../../components/ui/MetricCard';
import { useAsync } from '../../hooks/useAsync';
import { usePolling } from '../../hooks/usePolling';

type ConfirmKind = 'kill' | 'closeAll' | null;

export default function RiskPage() {
  return (
    <AppShell active="risk">
      <RiskBody />
    </AppShell>
  );
}

function RiskBody() {
  const { toast } = useApp();
  const [limitInput, setLimitInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);

  const { data: risk, loading, run, setData } = useAsync<RiskSettings>(async () => {
    const settings = await apiFetch<RiskSettings>('/api/settings');
    setLimitInput(settings.dailyLossLimit ?? '');
    return settings;
  }, []);

  usePolling(() => void run(true), 30000);

  const toggleTrading = async (enabled: boolean) => {
    setBusy(true);
    try {
      const updated = await apiFetch<{ tradingEnabled: boolean; liveTradingAcknowledgedAt: string | null }>('/api/settings', { method: 'PATCH', body: { tradingEnabled: enabled } });
      setData((current) => (current ? { ...current, tradingEnabled: updated.tradingEnabled, liveTradingAcknowledgedAt: updated.liveTradingAcknowledgedAt } : current));
      toast('success', enabled ? 'Live trading resumed.' : 'Live trading KILLED — new orders and bot runs are blocked.');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not toggle trading.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const saveLossLimit = async () => {
    const value = limitInput.trim();
    const dailyLossLimit = value === '' ? null : Number(value);
    if (dailyLossLimit !== null && (!Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0)) {
      toast('error', 'Daily loss limit must be a positive number (empty clears it).');
      return;
    }
    setBusy(true);
    try {
      const updated = await apiFetch<{ dailyLossLimit: string | null }>('/api/settings', { method: 'PATCH', body: { dailyLossLimit } });
      setData((current) => (current ? { ...current, dailyLossLimit: updated.dailyLossLimit } : current));
      setLimitInput(updated.dailyLossLimit ?? '');
      toast('success', dailyLossLimit === null ? 'Daily loss limit cleared.' : `Daily loss limit set to $${dailyLossLimit}.`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not update loss limit.');
    } finally {
      setBusy(false);
    }
  };

  const closeAllPositions = async () => {
    setBusy(true);
    try {
      const result = await apiFetch<{ accepted: boolean; operation: string }>('/api/orders/emergency/close-all', { method: 'POST', body: {} });
      toast('info', `Close-all submitted (${result.operation ?? 'ok'}).`);
      await run(true);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not submit close-all.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const tradingLive = risk?.tradingEnabled ?? false;
  const dailyPnl = formatPnl(risk?.dailyRealizedPnl ?? '0');
  const dailyPnlNegative = risk ? Number(risk.dailyRealizedPnl) < 0 : false;

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">RISK & SAFETY</p>
          <h1>Risk controls</h1>
          <p className="muted">Global safeguards that apply to every order, bot run and position on this terminal.</p>
        </div>
        <Button disabled={loading} onClick={() => void run()} variant="secondary">
          Refresh
        </Button>
      </header>

      <div className={`risk-card ${tradingLive ? '' : 'off'}`}>
        <div className="risk-summary">
          <div className="risk-icon">
            <ShieldCheck size={18} />
          </div>
          <div>
            <p>Live trading</p>
            <h3>
              <StatusBadge tone={tradingLive ? 'ok' : 'bad'}>{tradingLive ? 'TRADING LIVE' : 'TRADING KILLED'}</StatusBadge>
              {risk?.breakerTripped && <StatusBadge tone="bad">BREAKER TRIPPED</StatusBadge>}
            </h3>
            <small className="muted">
              Daily realized: <b className={dailyPnlNegative ? 'loss' : 'profit'}>{dailyPnl}</b>
              {' — '}Limit: {risk?.dailyLossLimit ? `$${formatNumber(risk.dailyLossLimit)}` : 'off'}
              {risk?.breakerReason ? ` — ${risk.breakerReason}` : ''}
            </small>
          </div>
        </div>
        <div className="risk-actions">
          {tradingLive ? (
            <Button variant="danger" disabled={busy} onClick={() => setConfirm('kill')} tone="danger">
              <Power size={14} /> Kill trading
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void toggleTrading(true)}>
              <Power size={14} /> Resume trading
            </Button>
          )}
          <Button disabled={busy} onClick={() => setConfirm('closeAll')} variant="secondary" tone="danger">
            <Layers size={14} /> Close all positions
          </Button>
          <label className="limit-row">
            <span className="muted small">Daily loss limit USDT</span>
            <input onChange={(event) => setLimitInput(event.target.value)} placeholder="e.g. 50 (empty = off)" type="number" value={limitInput} />
            <Button disabled={busy} onClick={() => void saveLossLimit()} variant="secondary">
              Set
            </Button>
          </label>
        </div>
      </div>

      <div className="grid metrics">
        <MetricCard
          icon={<Wallet size={19} />}
          label="Equity"
          value={risk?.equity ? `$${formatNumber(risk.equity)}` : '…'}
          sub="account equity"
        />
        <MetricCard
          icon={<Wallet size={19} />}
          label="Peak equity"
          value={risk?.peakEquity ? `$${formatNumber(risk.peakEquity)}` : '…'}
          sub="running high-water mark"
        />
        <MetricCard
          icon={<AlertTriangle size={19} />}
          label="Daily realized PnL"
          value={dailyPnl}
          valueClass={dailyPnlNegative ? 'loss' : 'profit'}
          sub={risk?.breakerDailyPnl ? `breaker threshold ${formatPnl(risk.breakerDailyPnl)}` : 'no breaker set'}
        />
        <MetricCard
          icon={<ShieldCheck size={19} />}
          label="Account"
          value={risk?.accountLabel ?? risk?.exchange ?? '—'}
          sub={risk?.marketType ? `${risk.marketType}${risk.accountId ? ` · ${risk.accountId.slice(0, 8)}` : ''}` : 'no account'}
        />
      </div>

      {risk?.mcpUrl && (
        <Card className="mcp-card">
          <div className="risk-summary">
            <div className="risk-icon">
              <ShieldCheck size={18} />
            </div>
            <div>
              <p>AI agent endpoint (MCP)</p>
              <h3>{risk.mcpUrl}</h3>
              <small className="muted">
                Connect any AI agent (Claude, Cursor, opencode, etc.) to this URL — send the password as <code>Authorization: Bearer &lt;password&gt;</code>. The password is configured via the MCP_PASSWORD environment variable.
              </small>
            </div>
          </div>
          <div className="risk-actions">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(risk.mcpUrl).catch(() => undefined);
                toast('success', 'MCP endpoint copied.');
              }}
            >
              <Copy size={14} /> Copy link
            </Button>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirm === 'kill'}
        title="Kill live trading?"
        description="New orders and bot runs will be blocked immediately. Open positions are NOT closed automatically — use Close all positions if you want to flatten everything."
        confirmLabel="Kill trading"
        busy={busy}
        onConfirm={() => void toggleTrading(false)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'closeAll'}
        title="Close ALL positions?"
        description="Place market reduce-only orders to close every open position on the primary account. This cannot be undone by the system."
        confirmLabel="Close all positions"
        busy={busy}
        onConfirm={() => void closeAllPositions()}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}