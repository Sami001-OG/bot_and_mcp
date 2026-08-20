'use client';

import { Bot, CirclePlus, Copy, Pause, Play, RefreshCw, Settings2, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { ApiHttpError, apiFetch } from '../../lib/session';
import { formatConfig, formatTime, STATUS_TONES } from '../../lib/format';
import type { Allocation, BotConfig, BotCreateResult, BotDetail, BotSecretReveal, BotSummary, ExchangeAccountRef, Market } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../../components/ui/Table';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';

const ACTION_OPTIONS = ['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'REVERSE', 'PARTIAL_EXIT'] as const;
const ALLOCATION_OPTIONS = ['NONE', 'PERCENT_EQUITY', 'PERCENT_MAX_EQUITY', 'FIXED_AMOUNT', 'RISK_PERCENT'] as const;

type EditTarget = { id: string; name: string; config: BotConfig };

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
      <BotsBody />
    </AppShell>
  );
}

function BotsBody() {
  const { toast, signOut } = useApp();
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ExchangeAccountRef[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selected, setSelected] = useState<BotDetail | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [secretReveal, setSecretReveal] = useState<BotSecretReveal | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadMarkets = useCallback(async () => {
    try {
      const data = await apiFetch<{ symbols: Market[] }>('/api/markets?quote=USDT');
      setMarkets(data.symbols);
      setMarketsError(null);
    } catch (error) {
      setMarkets(null);
      setMarketsError(error instanceof Error ? error.message : 'Failed to load markets from the exchange.');
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await apiFetch<{ accounts: ExchangeAccountRef[] }>('/api/exchange-accounts');
      setAccounts(data.accounts);
      const primary = data.accounts.find((account) => account.isPrimary) ?? data.accounts[0];
      setSelectedAccountId(primary?.id ?? '');
    } catch {
      setAccounts([]);
    }
  }, []);

  const loadBots = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ bots: BotSummary[] }>('/api/bots');
      setBots(data.bots);
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 401) {
        signOut();
        toast('error', 'Session expired — sign in again.');
      } else {
        toast('error', error instanceof Error ? error.message : 'Failed to load bots.');
      }
    } finally {
      setLoading(false);
    }
  }, [toast, signOut]);

  const loadDetail = useCallback(
    async (botId: string) => {
      try {
        const data = await apiFetch<{ bot: BotDetail }>(`/api/bots/${botId}`);
        setSelected(data.bot);
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Failed to load bot detail.');
      }
    },
    [toast],
  );

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
  };

  const openEdit = (bot: BotSummary) => {
    const configSymbols = bot.config?.symbols ?? [];
    setSymbols(configSymbols);
    setEditTarget({ id: bot.id, name: bot.name, config: bot.config });
    setCreateOpen(true);
  };

  const persistBot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    const form = new FormData(event.currentTarget);
    const symbols = String(form.get('symbols') ?? '')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length === 0) {
      toast('error', 'Enter at least one symbol, e.g. BTC/USDT.');
      setSaving(false);
      return;
    }
    if (!editTarget && !selectedAccountId) {
      toast('error', 'Choose the exchange API this bot trades with.');
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
    if (form.get('trailingEnabled') === 'on') {
      config.trailing = { enabled: true, callbackPercent: Number(form.get('trailingCallbackPercent')) };
    }

    try {
      if (editTarget) {
        await apiFetch(`/api/bots/${editTarget.id}`, { method: 'PATCH', body: { config } });
        toast('success', `Bot "${editTarget.name}" updated (new version created).`);
      } else {
        const name = String(form.get('name') ?? '').trim();
        const password = String(form.get('password') ?? '').trim();
        const result = await apiFetch<BotCreateResult>('/api/bots', { method: 'POST', body: { name, exchangeAccountId: selectedAccountId, ...(password ? { password } : {}), config } });
        setSecretReveal({
          botName: result.bot.name,
          url: webhookUrl(result.webhook.id),
          signingSecret: result.webhook.signingSecret,
          mcpUrl: botMcpUrl(result.bot.id),
        });
        toast('success', `Bot "${result.bot.name}" created and ACTIVE.`);
      }
      setCreateOpen(false);
      await loadBots();
      if (selected) void loadDetail(selected.id);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to save bot.');
    } finally {
      setSaving(false);
    }
  };

  const setBotStatus = async (bot: BotSummary, action: 'pause' | 'resume' | 'stop') => {
    try {
      await apiFetch(`/api/bots/${bot.id}/${action}`, { method: 'POST', body: {} });
      const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'stopped';
      toast('success', `Bot "${bot.name}" ${verb}.`);
      await loadBots();
      if (selected?.id === bot.id) void loadDetail(bot.id);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Status change failed.');
    }
  };

  const deleteBot = async (bot: BotSummary) => {
    if (!window.confirm(`Delete bot "${bot.name}" permanently? Its webhook endpoint, runs and versions are removed.`)) return;
    try {
      await apiFetch(`/api/bots/${bot.id}`, { method: 'DELETE' });
      toast('success', `Bot "${bot.name}" deleted.`);
      if (selected?.id === bot.id) setSelected(null);
      await loadBots();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not delete bot.');
    }
  };

  const deleteAllBots = async () => {
    if (!window.confirm(`Delete ALL ${bots.length} bot(s)? Their webhook endpoints, runs and versions are removed. This cannot be undone.`)) return;
    try {
      const result = await apiFetch<{ deleted: number }>('/api/bots', { method: 'DELETE' });
      toast('success', `Deleted ${result.deleted} bot(s).`);
      setSelected(null);
      await loadBots();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not delete bots.');
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
          {bots.length > 0 && (
            <Button disabled={loading} onClick={() => void deleteAllBots()} variant="secondary" tone="danger">
              <Trash2 size={15} /> Delete all
            </Button>
          )}
          <Button onClick={openCreate} variant="primary">
            <CirclePlus size={17} /> New bot
          </Button>
        </div>
      </header>

      <div className="bot-layout">
        <Card className="bot-list-card">
          <CardHeader
            eyebrow="BOTS"
            title={`${bots.length} configured`}
            right={
              <Button disabled={loading} onClick={() => void loadBots()} variant="secondary">
                <RefreshCw size={14} /> Refresh
              </Button>
            }
          />
          <TableScroll>
            {!loading && bots.length === 0 && <EmptyState>No bots yet — create one to connect a TradingView webhook.</EmptyState>}
            {bots.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <Th>Bot</Th>
                    <Th>Webhook</Th>
                    <Th>Status</Th>
                    <Th>Version</Th>
                    <Th>Config</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {bots.map((bot) => (
                    <tr className={selected?.id === bot.id ? 'selected-row' : ''} key={bot.id} onClick={() => void loadDetail(bot.id)}>
                      <Td>
                        <b>{bot.name}</b>
                        <small className="muted block">{bot.type}{bot.exchangeAccount ? ` · ${bot.exchangeAccount.label ?? bot.exchangeAccount.exchange} ${bot.exchangeAccount.marketType}` : ''}</small>
                      </Td>
                      <Td className="webhook-cell">
                        {bot.webhook ? (
                          <button
                            className="wh-copy"
                            onClick={async (event) => {
                              event.stopPropagation();
                              const copied = await copyText(webhookUrl(bot.webhook!.id));
                              toast(copied ? 'success' : 'error', copied ? `Webhook URL for "${bot.name}" copied.` : 'Could not copy — select the URL manually.');
                            }}
                            title="Copy webhook URL"
                            type="button"
                          >
                            <code>/{bot.webhook.id.slice(0, 8)}</code><Copy size={13} />
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </Td>
                      <Td>
                        <StatusBadge tone={STATUS_TONES[bot.status]}>{bot.status}</StatusBadge>
                      </Td>
                      <Td>v{bot.activeVersion}</Td>
                      <Td className="config-cell" title={formatConfig(bot.config)}>{formatConfig(bot.config)}</Td>
                      <Td className="row-actions" onMouseDown={(event) => event.stopPropagation()}>
                        {bot.status !== 'ACTIVE' && <button className="icon-btn safe" onClick={() => void setBotStatus(bot, 'resume')} title="Resume" type="button"><Play size={14} /></button>}
                        {bot.status === 'ACTIVE' && <button className="icon-btn" onClick={() => void setBotStatus(bot, 'pause')} title="Pause" type="button"><Pause size={14} /></button>}
                        <button className="icon-btn" onClick={() => openEdit(bot)} title="Edit config" type="button"><Settings2 size={14} /></button>
                        {bot.status !== 'STOPPED' && <button className="icon-btn danger" onClick={() => void setBotStatus(bot, 'stop')} title="Stop" type="button"><Square size={14} /></button>}
                        <button className="icon-btn danger" onClick={() => void deleteBot(bot)} title="Delete permanently" type="button"><Trash2 size={14} /></button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </TableScroll>
        </Card>

        {selected ? (
          <Card className="bot-detail-card">
            <CardHeader
              eyebrow="BOT DETAIL"
              title={
                <>
                  {selected.name} <small className="muted">v{selected.activeVersion}</small>
                </>
              }
              right={
                <button aria-label="Close detail" className="icon-btn" onClick={() => setSelected(null)} type="button">
                  <X size={16} />
                </button>
              }
            />
            <p className="muted small config-line">{formatConfig(selected.config)}</p>
            {selected.webhook && (
              <div className="bot-webhook">
                <p className="eyebrow">WEBHOOK ENDPOINT</p>
                <div className="wh-row">
                  <code className="wh-url">{webhookUrl(selected.webhook.id)}</code>
                  <Button onClick={() => void copyText(webhookUrl(selected.webhook!.id))} size="sm" variant="secondary">
                    <Copy size={14} /> Copy URL
                  </Button>
                </div>
                <p className="muted small">
                  TradingView strategy alerts sent to this URL run <b>only this bot</b> · leverage {selected.config.leverage ?? '1'}x
                </p>
                <p className="eyebrow" style={{ marginTop: '0.75rem' }}>MCP ENDPOINT</p>
                <div className="wh-row">
                  <code className="wh-url">{botMcpUrl(selected.id)}</code>
                  <Button onClick={() => void copyText(botMcpUrl(selected.id))} size="sm" variant="secondary">
                    <Copy size={14} /> Copy URL
                  </Button>
                </div>
                <p className="muted small">
                  MCP client: <code>npx mcp-remote {botMcpUrl(selected.id)}</code> — authenticate with the bot&apos;s webhook signing secret.
                </p>
              </div>
            )}
            <h3>Runs <span className="muted">(last {selected.runs.length})</span></h3>
            {selected.runs.length === 0 && <EmptyState>No runs yet — every routed webhook signal records a run.</EmptyState>}
            <div className="timeline">
              {selected.runs.map((run) => (
                <div className="timeline-item" key={run.id}>
                  <span className={`dot ${run.status === 'ERROR' ? 'warn' : 'ok'}`} />
                  <div className="timeline-body">
                    <div className="timeline-head">
                      <b>{String(run.metrics.action ?? run.status)}</b>
                      <StatusBadge tone={run.status === 'ERROR' ? 'bad' : 'ok'}>{run.status}</StatusBadge>
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
                  <StatusBadge tone={version.version === selected.activeVersion ? 'ok' : 'muted'}>v{version.version}</StatusBadge>
                  <code title={formatConfig(version.config)}>{formatConfig(version.config)}</code>
                  <em>{formatTime(version.createdAt)}</em>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card className="bot-detail-card placeholder">
            <Bot size={28} />
            <p>Select a bot to view its runs timeline and version history.</p>
          </Card>
        )}
      </div>

      {secretReveal && (
        <Modal open eyebrow="ONE-TIME SECRET" title={`Webhook & MCP access for "${secretReveal.botName}"`} onClose={() => setSecretReveal(null)}>
          <p className="muted small">
            Copy these into your TradingView strategy alert and MCP client. The password is shown <b>only now</b> — it signs webhooks (HMAC) and authorizes MCP.
          </p>
          <label className="secret-field">
            <span>Webhook URL</span>
            <div className="secret-box">
              <code>{secretReveal.url}</code>
              <Button onClick={() => void copyText(secretReveal.url)} size="sm" variant="secondary">
                <Copy size={14} /> Copy
              </Button>
            </div>
          </label>
          <label className="secret-field">
            <span>MCP URL</span>
            <div className="secret-box">
              <code>{secretReveal.mcpUrl}</code>
              <Button onClick={() => void copyText(secretReveal.mcpUrl)} size="sm" variant="secondary">
                <Copy size={14} /> Copy
              </Button>
            </div>
          </label>
          <label className="secret-field">
            <span>Password (webhook HMAC secret = MCP Bearer token)</span>
            <div className="secret-box">
              <code>{secretReveal.signingSecret}</code>
              <Button onClick={() => void copyText(secretReveal.signingSecret)} size="sm" variant="secondary">
                <Copy size={14} /> Copy
              </Button>
            </div>
          </label>
          <div className="modal-actions">
            <Button onClick={() => setSecretReveal(null)} variant="primary">
              Done
            </Button>
          </div>
        </Modal>
      )}

      {createOpen && (
        <Modal open wide eyebrow={editTarget ? 'EDIT CONFIG' : 'AUTOMATION'} title={editTarget ? `Edit ${editTarget.name}` : 'New webhook bot'} onClose={() => setCreateOpen(false)}>
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
                Trading API: {selected && selected.exchangeAccount ? `${selected.exchangeAccount.label ?? selected.exchangeAccount.exchange} ${selected.exchangeAccount.marketType}` : 'bound at creation'}
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

            <fieldset className="action-field">
              <legend>Trailing stop</legend>
              <label className="checkbox"><input defaultChecked={prefill?.trailing?.enabled ?? false} name="trailingEnabled" type="checkbox" /> Attach a trailing stop to every entry</label>
              <label>Callback %<input defaultValue={prefill?.trailing?.callbackPercent ?? 1.5} min="0.01" name="trailingCallbackPercent" step="any" type="number" /></label>
              <p className="muted small">A reduce-only trailing stop activates at the entry price. Once price moves {prefill?.trailing?.callbackPercent ?? 1.5}% past the highest point, the stop follows the price. Can be combined with a fixed stop loss.</p>
            </fieldset>
            <div className="modal-actions">
              <Button onClick={() => setCreateOpen(false)} variant="secondary">
                Cancel
              </Button>
              <Button disabled={saving} variant="primary" type="submit">
                {saving ? 'Saving…' : editTarget ? 'Save config' : 'Create bot'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}