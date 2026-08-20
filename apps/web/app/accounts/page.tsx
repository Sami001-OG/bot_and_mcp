'use client';

import { Plus, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { apiFetch } from '../../lib/session';
import { formatTime, MARKET_TYPES } from '../../lib/format';
import type { ExchangeAccount } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../../components/ui/Table';
import { EmptyState } from '../../components/ui/EmptyState';

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
  const [creating, setCreating] = useState(false);
  const [marketType, setMarketType] = useState<string>('USDT_FUTURES');
  const [testnet, setTestnet] = useState(false);
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');

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

  const createAccount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiKey.trim() || !secret.trim()) {
      toast('error', 'API key and secret are required.');
      return;
    }
    setCreating(true);
    try {
      const result = await apiFetch<{ account: ExchangeAccount }>('/api/exchange-accounts', {
        method: 'POST',
        body: { exchange: 'bybit', marketType, testnet, ...(label.trim() ? { label: label.trim() } : {}), apiKey: apiKey.trim(), secret: secret.trim() },
      });
      setApiKey('');
      setSecret('');
      toast('success', `Added ${result.account.exchange} account. Credentials are encrypted at rest — they are never shown again.`);
      await loadAccounts();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not add account.');
    } finally {
      setCreating(false);
    }
  };

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

  const removeAccount = async (account: ExchangeAccount, force = false) => {
    if (force) {
      if (!window.confirm(`Delete "${account.label ?? account.exchange}" AND its ${account.botCount} bot(s)? Bots, webhook endpoints, runs and versions are removed too. This cannot be undone.`)) return;
    } else if (!window.confirm(`Delete ${account.label ?? account.exchange} account? This cannot be undone.`)) {
      return;
    }
    try {
      const result = await apiFetch<{ ok: boolean; removedBots?: number }>(`/api/exchange-accounts/${account.id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
      toast('success', force ? `Account deleted, ${result.removedBots ?? account.botCount} bot(s) removed.` : 'Account deleted.');
      await loadAccounts();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete account.';
      if (!force && /ACCOUNT_IN_USE|in use/i.test(message)) {
        toast('error', `${message} — delete again to remove its bots too.`);
      } else {
        toast('error', message);
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

      <Card className="connect-card">
        <CardHeader eyebrow="NEW API" title="Add a Bybit API key" right={<ShieldCheck size={16} className="muted" />} />
        <form className="connect-form" onSubmit={createAccount}>
          <div className="form-grid">
            <label>
              Exchange
              <input disabled value="bybit" />
            </label>
            <label>
              Market type
              <select onChange={(event) => setMarketType(event.target.value)} value={marketType}>
                {MARKET_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input checked={testnet} onChange={(event) => setTestnet(event.target.checked)} type="checkbox" />
              <span>Bybit <b>testnet</b> (test funds, USDT-M testnet keys from testnet.bybit.com)</span>
            </label>
            <label>
              Label (optional)
              <input onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Main futures account" value={label} />
            </label>
            <label>
              API key
              <input autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="Bybit API key" required value={apiKey} />
            </label>
            <label>
              API secret
              <input autoComplete="off" onChange={(event) => setSecret(event.target.value)} placeholder="Bybit API secret" required type="password" value={secret} />
            </label>
          </div>
          <div className="connect-submit">
            <Button disabled={creating} variant="primary" type="submit">
              <Plus size={14} /> {creating ? 'Adding…' : 'Add account'}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          eyebrow="ACCOUNTS"
          title={`${accounts.length} configured`}
          right={<span className="muted small">primary is used for manual orders</span>}
        />
        <TableScroll>
          {!loading && accounts.length === 0 && <EmptyState>No exchange APIs yet — add one above. Bots cannot be created without an API.</EmptyState>}
          {accounts.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Label</Th>
                  <Th>Exchange</Th>
                  <Th>Market</Th>
                  <Th>Key</Th>
                  <Th>Bots</Th>
                  <Th>Primary</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <Td>
                      <b>{account.label ?? `${account.exchange} ${account.marketType}`}</b>
                      {account.testnet && (
                        <StatusBadge tone="warn" title="Bybit testnet account — test funds only">
                          TESTNET
                        </StatusBadge>
                      )}
                    </Td>
                    <Td>{account.exchange}</Td>
                    <Td>{account.marketType}</Td>
                    <Td>
                      <code>{account.keyPreview}</code>
                    </Td>
                    <Td>{account.botCount}</Td>
                    <Td>
                      <button className="link-button" disabled={account.isPrimary} onClick={() => void setPrimary(account.id, account.isPrimary)} type="button">
                        {account.isPrimary ? (
                          <StatusBadge tone="ok">
                            <Star size={12} /> PRIMARY
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone="muted">set primary</StatusBadge>
                        )}
                      </button>
                    </Td>
                    <Td>{formatTime(account.createdAt)}</Td>
                    <Td>
                      <button aria-label={`Delete ${account.label ?? account.exchange}`} className="icon-button danger" onClick={() => void removeAccount(account)} title={account.botCount > 0 ? `Delete account and its ${account.botCount} bot(s)` : 'Delete account'} type="button">
                        <Trash2 size={14} />
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableScroll>
        <p className="muted small pad-top">
          The API key and secret are encrypted with the ENCRYPTION_KEY and stored in MongoDB. No API is hardcoded in the application or environment — the bot uses the credentials bound to it at creation time.
        </p>
      </Card>
    </>
  );
}