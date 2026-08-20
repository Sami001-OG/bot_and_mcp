'use client';

import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { apiFetch } from '../../lib/session';
import type { ExchangeAccount } from '../../lib/types';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { AccountForm } from '../../components/domain/AccountForm';
import { AccountTable } from '../../components/domain/AccountTable';

type DeleteTarget = { account: ExchangeAccount; force: boolean };

export default function AccountsPage() {
  return (
    <AppShell active="accounts">
      <AccountsBody />
    </AppShell>
  );
}

function AccountsBody() {
  const { toast } = useApp();
  const [accounts, setAccounts] = useState<ExchangeAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ accounts: ExchangeAccount[] }>('/api/exchange-accounts');
      setAccounts(data.accounts);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to load exchange accounts.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const setPrimary = async (id: string, current: boolean) => {
    if (current) return;
    try {
      await apiFetch<{ account: ExchangeAccount }>(`/api/exchange-accounts/${id}`, { method: 'PATCH', body: {} });
      toast('success', 'Primary account updated.');
      await loadAccounts();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not update primary account.');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { account, force } = deleteTarget;
    try {
      const result = await apiFetch<{ ok: boolean; removedBots?: number }>(`/api/exchange-accounts/${account.id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
      toast('success', force ? `Account deleted, ${result.removedBots ?? account.botCount} bot(s) removed.` : 'Account deleted.');
      await loadAccounts();
      setDeleteTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete account.';
      if (!force && /ACCOUNT_IN_USE|in use/i.test(message)) {
        setDeleteTarget({ account, force: true });
        toast('error', `${message} — confirm again to delete its bots too.`);
      } else {
        toast('error', message);
        setDeleteTarget(null);
      }
    }
  };

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">EXCHANGE CREDENTIALS</p>
          <h1>Exchange APIs</h1>
          <p className="muted">Every bot is created with one of these APIs. Credentials are AES-256-GCM encrypted at rest and never returned by the API.</p>
        </div>
      </header>

      <AccountForm onCreated={loadAccounts} />

      <Card>
        <AccountTable accounts={accounts} loading={loading} onDelete={(account) => setDeleteTarget({ account, force: false })} onSetPrimary={(id, current) => void setPrimary(id, current)} />
        <p className="muted small pad-top">
          The API key and secret are encrypted with the ENCRYPTION_KEY and stored in MongoDB. No API is hardcoded in the application or environment — the bot uses the credentials bound to it at creation time.
        </p>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget?.force
            ? `Delete "${deleteTarget.account.label ?? deleteTarget.account.exchange}" AND its ${deleteTarget.account.botCount} bot(s)?`
            : `Delete ${deleteTarget?.account.label ?? deleteTarget?.account.exchange ?? ''} account?`
        }
        description={
          deleteTarget?.force
            ? 'Bots, webhook endpoints, runs and versions are removed too. This cannot be undone.'
            : 'This cannot be undone.'
        }
        confirmLabel={deleteTarget?.force ? 'Delete account + bots' : 'Delete account'}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}