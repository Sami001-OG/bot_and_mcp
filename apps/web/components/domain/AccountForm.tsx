'use client';

import { Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../layout/AppContext';
import { apiFetch } from '../../lib/session';
import { MARKET_TYPES } from '../../lib/format';
import type { ExchangeAccount } from '../../lib/types';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';

export function AccountForm({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const { toast } = useApp();
  const [creating, setCreating] = useState(false);
  const [marketType, setMarketType] = useState<string>('USDT_FUTURES');
  const [testnet, setTestnet] = useState(false);
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');

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
      await onCreated();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not add account.');
    } finally {
      setCreating(false);
    }
  };

  return (
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
  );
}