'use client';

import { Copy, KeyRound, Plus, Webhook } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell, { type ShellContext } from '../components/AppShell';
import { apiFetch, type AuthSession } from '../../lib/session';

type WebhookEndpoint = {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  _count: { deliveries: number };
};

type CreateResult = {
  id: string;
  name: string;
  signingSecret: string;
  url: string;
};

function endpointUrl(endpointId: string): string {
  if (typeof window === 'undefined') return `https://<host>/api/webhooks/tradingview/${endpointId}`;
  return `${window.location.origin}/api/webhooks/tradingview/${endpointId}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const SAMPLE_PAYLOAD = `{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "BUY",
  "size": 0.01,
  "timestamp": 1750000000000,
  "nonce": "8f2a91c4-..."
}`;

export default function WebhooksPage() {
  return (
    <AppShell active="webhooks">
      {({ session, setNotice }) => <WebhooksBody session={session} setNotice={setNotice} />}
    </AppShell>
  );
}

function WebhooksBody({ session, setNotice }: { session: AuthSession; setNotice: ShellContext['setNotice'] }) {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreateResult | null>(null);

  const loadEndpoints = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ endpoints: WebhookEndpoint[] }>('/api/webhooks', session);
      setEndpoints(data.endpoints);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load webhook endpoints.' });
    } finally {
      setLoading(false);
    }
  }, [session, setNotice]);

  useEffect(() => {
    void loadEndpoints();
  }, [loadEndpoints]);

  const createEndpoint = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      setNotice({ tone: 'error', message: 'Give the endpoint a name.' });
      return;
    }
    setCreating(true);
    try {
      const result = await apiFetch<CreateResult>('/api/webhooks', session, { method: 'POST', body: { name: name.trim() } });
      setCreated(result);
      setName('');
      setNotice({ tone: 'success', message: `Endpoint "${result.name}" created — copy the signing secret now, it is shown only once.` });
      await loadEndpoints();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not create endpoint.' });
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setNotice({ tone: 'info', message: `${label} copied to clipboard.` });
  };

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">TRADINGVIEW INGESTION</p>
          <h1>Webhooks</h1>
          <p className="muted">Endpoints that receive signed TradingView alerts and route them to your ACTIVE bots.</p>
        </div>
      </header>

      <article className="connect-card">
        <div className="card-head">
          <div>
            <p>NEW ENDPOINT</p>
            <h3>Create a webhook URL</h3>
          </div>
          <Webhook size={16} className="muted" />
        </div>
        <form className="connect-form" onSubmit={createEndpoint}>
          <label>
            Name
            <input onChange={(event) => setName(event.target.value)} placeholder="e.g. btc-strategy-alerts" required value={name} />
          </label>
          <div className="connect-submit">
            <button className="primary" disabled={creating} type="submit">
              <Plus size={14} /> {creating ? 'Creating…' : 'Create endpoint'}
            </button>
          </div>
        </form>
      </article>

      {created && (
        <article className="secret-card">
          <div className="card-head">
            <div>
              <p>ONE-TIME SECRET</p>
              <h3>{created.name} — signing secret</h3>
            </div>
            <KeyRound size={16} />
          </div>
          <p className="muted small">
            This secret is <b>shown only once</b>. Store it now — it signs every TradingView alert with HMAC-SHA256 of the raw body sent as the{' '}
            <code>x-tradingview-signature</code> header. Alerts also need a <code>nonce</code> and a <code>timestamp</code> within ±5 minutes.
          </p>
          <div className="secret-box">
            <code>{created.signingSecret}</code>
            <button className="secondary" onClick={() => void copy(created.signingSecret, 'Signing secret')} type="button">
              <Copy size={14} /> Copy
            </button>
          </div>
          <div className="endpoint-url">
            <span className="muted small">Webhook URL</span>
            <code>{endpointUrl(created.id)}</code>
            <button className="secondary" onClick={() => void copy(endpointUrl(created.id), 'Webhook URL')} type="button">
              <Copy size={14} /> Copy
            </button>
          </div>
          <div className="payload-sample">
            <span className="muted small">Payload format (TradingView alert message)</span>
            <pre>{SAMPLE_PAYLOAD}</pre>
          </div>
          <p className="muted small">
            In TradingView: open the alert → Notifications → Webhook URL → paste the URL. Enable the "Message" field with the JSON above and sign it
            (the signature is the hex HMAC-SHA256 of the exact message body using this secret).
          </p>
        </article>
      )}

      <article>
        <div className="card-head">
          <div>
            <p>ENDPOINTS</p>
            <h3>{endpoints.length} configured</h3>
          </div>
          <span className="muted small">signature required</span>
        </div>
        <div className="table-scroll">
          {!loading && endpoints.length === 0 && <p className="muted empty">No endpoints yet — create one and point a TradingView alert at it.</p>}
          {endpoints.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Deliveries</th>
                  <th>URL</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td>
                      <b>{endpoint.name}</b>
                      <small className="muted block">HMAC-signed</small>
                    </td>
                    <td>
                      <span className={`status-label ${endpoint.active ? 'ok' : 'muted'}`}>{endpoint.active ? 'ACTIVE' : 'DISABLED'}</span>
                    </td>
                    <td>{endpoint._count.deliveries}</td>
                    <td>
                      <code className="url-cell" title={endpointUrl(endpoint.id)}>{endpointUrl(endpoint.id)}</code>
                    </td>
                    <td>{formatTime(endpoint.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </article>
    </>
  );
}
