'use client';

import { Plus, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell, { type ShellContext } from '../components/AppShell';
import { apiFetch, type AuthSession } from '../../lib/session';

type ExchangeAccount = {
  id: string;
  exchange: string;
  marketType: string;
  label: string | null;
  isPrimary: boolean;
  keyPreview: string;
  botCount: number;
  createdAt: string;
};

const MARKET_TYPES = ['USDT_FUTURES', 'SPOT', 'COIN_FUTURES', 'PERPETUAL', 'MARGIN'] as const;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AccountsPage() {
  return (
    <AppShell active="accounts">
      {({ session, setNotice }) => <AccountsBody session={session} setNotice={setNotice} />}
    </AppShell>
  );
}

function AccountsBody({ session, setNotice }: { session: AuthSession; setNotice: ShellContext['setNotice'] }) {
  const [accounts, setAccounts] = useState<ExchangeAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [marketType, setMarketType] = useState<string>('USDT_FUTURES');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ accounts: ExchangeAccount[] }>('/api/exchange-accounts', session);
      setAccounts(data.accounts);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load exchange accounts.' });
    } finally {
      setLoading(false);
    }
  }, [session, setNotice]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const createAccount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiKey.trim() || !secret.trim()) {
      setNotice({ tone: 'error', message: 'API key and secret are required.' });
      return;
    }
    setCreating(true);
    try {
      const result = await apiFetch<{ account: ExchangeAccount }>('/api/exchange-accounts', session, {
        method: 'POST',
        body: { exchange: 'bybit', marketType, ...(label.trim() ? { label: label.trim() } : {}), apiKey: apiKey.trim(), secret: secret.trim() },
      });
      setApiKey('');
      setSecret('');
      setNotice({ tone: 'success', message: `Added ${result.account.exchange} account. Credentials are encrypted at rest — they are never shown again.` });
      await loadAccounts();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not add account.' });
    } finally {
      setCreating(false);
    }
  };

  const setPrimary = async (id: string, current: boolean) => {
    if (current) return;
    try {
      await apiFetch<{ account: ExchangeAccount }>(`/api/exchange-accounts/${id}`, session, { method: 'PATCH', body: {} });
      setNotice({ tone: 'success', message: 'Primary account updated.' });
      await loadAccounts();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not update primary account.' });
    }
  };

  const removeAccount = async (account: ExchangeAccount, force = false) => {
    if (force) {
      if (!window.confirm(`Delete "${account.label ?? account.exchange}" AND its ${account.botCount} bot(s)? Bots, webhook endpoints, runs and versions are removed too. This cannot be undone.`)) return;
    } else if (!window.confirm(`Delete ${account.label ?? account.exchange} account? This cannot be undone.`)) {
      return;
    }
    try {
      const result = await apiFetch<{ ok: boolean; removedBots?: number }>(`/api/exchange-accounts/${account.id}${force ? '?force=true' : ''}`, session, { method: 'DELETE' });
      setNotice({ tone: 'success', message: force ? `Account deleted, ${result.removedBots ?? account.botCount} bot(s) removed.` : 'Account deleted.' });
      await loadAccounts();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete account.';
      if (!force && /ACCOUNT_IN_USE|in use/i.test(message)) {
        setNotice({ tone: 'error', message: `${message} — delete again to remove its bots too.` });
      } else {
        setNotice({ tone: 'error', message });
      }
    }
  };

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">EXCHANGE CREDENTIALS</p>
          <h1>Exchange APIs</h1>
          <p className="muted">
            Every bot is created with one of these APIs. Credentials are AES-256-GCM encrypted at rest and never returned by the API.
          </p>
        </div>
      </header>

      <article className="connect-card">
        <div className="card-head">
          <div>
            <p>NEW API</p>
            <h3>Add a Bybit API key</h3>
          </div>
          <ShieldCheck size={16} className="muted" />
        </div>
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
            <button className="primary" disabled={creating} type="submit">
              <Plus size={14} /> {creating ? 'Adding…' : 'Add account'}
            </button>
          </div>
        </form>
      </article>

      <article>
        <div className="card-head">
          <div>
            <p>ACCOUNTS</p>
            <h3>{accounts.length} configured</h3>
          </div>
          <span className="muted small">primary is used for manual orders</span>
        </div>
        <div className="table-scroll">
          {!loading && accounts.length === 0 && <p className="muted empty">No exchange APIs yet — add one above. Bots cannot be created without an API.</p>}
          {accounts.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Exchange</th>
                  <th>Market</th>
                  <th>Key</th>
                  <th>Bots</th>
                  <th>Primary</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <b>{account.label ?? `${account.exchange} ${account.marketType}`}</b>
                    </td>
                    <td>{account.exchange}</td>
                    <td>{account.marketType}</td>
                    <td>
                      <code>{account.keyPreview}</code>
                    </td>
                    <td>{account.botCount}</td>
                    <td>
                      <button className="link-button" disabled={account.isPrimary} onClick={() => void setPrimary(account.id, account.isPrimary)} type="button">
                        {account.isPrimary ? (
                          <span className="status-label ok">
                            <Star size={12} /> PRIMARY
                          </span>
                        ) : (
                          <span className="status-label muted">set primary</span>
                        )}
                      </button>
                    </td>
                    <td>{formatTime(account.createdAt)}</td>
                    <td>
                      <button aria-label={`Delete ${account.label ?? account.exchange}`} className="icon-button danger" onClick={() => void removeAccount(account)} title={account.botCount > 0 ? `Delete account and its ${account.botCount} bot(s)` : 'Delete account'} type="button">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="muted small pad-top">
          The API key and secret are encrypted with the ENCRYPTION_KEY and stored in MongoDB. No API is hardcoded in the application or environment —
          the bot uses the credentials bound to it at creation time.
        </p>
      </article>
    </>
  );
}