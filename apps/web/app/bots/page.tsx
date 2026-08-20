'use client';

import { CirclePlus, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { ApiHttpError, apiFetch } from '../../lib/session';
import type { BotConfig, BotDetail, BotSecretReveal, BotSummary, ExchangeAccountRef, Market } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { BotListTable } from '../../components/domain/BotListTable';
import { BotDetailPanel, BotDetailPlaceholder } from '../../components/domain/BotDetailPanel';
import { BotFormModal } from '../../components/domain/BotFormModal';

type EditTarget = { id: string; name: string; config: BotConfig };

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
  const [deleteTarget, setDeleteTarget] = useState<BotSummary | null>(null);
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false);
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
    setSymbols(bot.config?.symbols ?? []);
    setEditTarget({ id: bot.id, name: bot.name, config: bot.config });
    setCreateOpen(true);
  };

  const handleSaved = async (reveal: BotSecretReveal | null) => {
    setCreateOpen(false);
    setSecretReveal(reveal);
    await loadBots();
    if (selected) void loadDetail(selected.id);
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

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiFetch(`/api/bots/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', `Bot "${deleteTarget.name}" deleted.`);
      if (selected?.id === deleteTarget.id) setSelected(null);
      await loadBots();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not delete bot.');
    } finally {
      setDeleteTarget(null);
    }
  };

  const confirmDeleteAll = async () => {
    try {
      const result = await apiFetch<{ deleted: number }>('/api/bots', { method: 'DELETE' });
      toast('success', `Deleted ${result.deleted} bot(s).`);
      setSelected(null);
      await loadBots();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not delete bots.');
    } finally {
      setDeleteAllConfirm(false);
    }
  };

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">AUTOMATED TRADING</p>
          <h1>Bots</h1>
          <p className="muted">Webhook bots trade exclusively — signals and MCP trades only execute through ACTIVE bots.</p>
        </div>
        <div className="header-actions">
          <Button onClick={openCreate} variant="primary">
            <CirclePlus size={17} /> New bot
          </Button>
        </div>
      </header>

      <div className="bot-layout">
        <Card className="bot-list-card">
          <BotListTable
            bots={bots}
            loading={loading}
            onDelete={(bot) => setDeleteTarget(bot)}
            onDeleteAll={() => setDeleteAllConfirm(true)}
            onEdit={openEdit}
            onPause={(bot) => void setBotStatus(bot, 'pause')}
            onRefresh={() => void loadBots()}
            onResume={(bot) => void setBotStatus(bot, 'resume')}
            onSelect={(id) => void loadDetail(id)}
            onStop={(bot) => void setBotStatus(bot, 'stop')}
            selectedId={selected?.id ?? null}
          />
        </Card>

        {selected ? (
          <Card className="bot-detail-card">
            <BotDetailPanel bot={selected} onClose={() => setSelected(null)} />
          </Card>
        ) : (
          <Card className="bot-detail-card placeholder">
            <BotDetailPlaceholder />
          </Card>
        )}
      </div>

      <BotFormModal
        accounts={accounts}
        editTarget={editTarget}
        markets={markets}
        marketsError={marketsError}
        onAccountChange={setSelectedAccountId}
        onClose={() => setCreateOpen(false)}
        onRetryMarkets={() => void loadMarkets()}
        onSaved={handleSaved}
        onSymbolsChange={setSymbols}
        open={createOpen}
        selected={selected}
        selectedAccountId={selectedAccountId}
        symbols={symbols}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.name ?? ''}"?`}
        description="Its webhook endpoint, runs and versions are removed permanently. This cannot be undone."
        confirmLabel="Delete bot"
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={deleteAllConfirm}
        title={`Delete ALL ${bots.length} bot(s)?`}
        description="Their webhook endpoints, runs and versions are removed. This cannot be undone."
        confirmLabel="Delete all"
        tone="danger"
        onCancel={() => setDeleteAllConfirm(false)}
        onConfirm={() => void confirmDeleteAll()}
      />

      {secretReveal && (
        <SecretRevealModal reveal={secretReveal} onClose={() => setSecretReveal(null)} />
      )}
    </>
  );
}

function SecretRevealModal({ reveal, onClose }: { reveal: BotSecretReveal; onClose: () => void }) {
  const { toast } = useApp();
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', `${label} copied.`);
    } catch {
      toast('error', `Could not copy ${label.toLowerCase()} — select it manually.`);
    }
  };

  return (
    <Modal open eyebrow="ONE-TIME SECRET" title={`Webhook & MCP access for "${reveal.botName}"`} onClose={onClose}>
      <p className="muted small">
        Copy these into your TradingView strategy alert and MCP client. The password is shown <b>only now</b> — it signs webhooks (HMAC) and authorizes MCP.
      </p>
      <label className="secret-field">
        <span>Webhook URL</span>
        <div className="secret-box">
          <code>{reveal.url}</code>
          <Button onClick={() => void copy(reveal.url, 'Webhook URL')} size="sm" variant="secondary">
            <Copy size={14} /> Copy
          </Button>
        </div>
      </label>
      <label className="secret-field">
        <span>MCP URL</span>
        <div className="secret-box">
          <code>{reveal.mcpUrl}</code>
          <Button onClick={() => void copy(reveal.mcpUrl, 'MCP URL')} size="sm" variant="secondary">
            <Copy size={14} /> Copy
          </Button>
        </div>
      </label>
      <label className="secret-field">
        <span>Password (webhook HMAC secret = MCP Bearer token)</span>
        <div className="secret-box">
          <code>{reveal.signingSecret}</code>
          <Button onClick={() => void copy(reveal.signingSecret, 'Password')} size="sm" variant="secondary">
            <Copy size={14} /> Copy
          </Button>
        </div>
      </label>
      <div className="modal-actions">
        <Button onClick={onClose} variant="primary">
          Done
        </Button>
      </div>
    </Modal>
  );
}