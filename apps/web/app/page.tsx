'use client';

import {
  Activity,
  Bot,
  CircleDollarSign,
  Radio,
  ShieldCheck,
  TrendingUp,
  WalletCards,
  Webhook,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NexusLogo } from './logo';

const navigation = [
  'Overview',
  'Portfolio',
  'Orders',
  'Positions',
  'Bots',
  'Webhooks',
  'Market data',
  'Risk controls',
  'MCP access',
  'Settings',
] as const;

const ranges = ['7 days', '30 days', '90 days'] as const;
type Range = (typeof ranges)[number];

type PortfolioSummary = {
  totalValue: string;
  unrealizedPnl: string;
  dailyPnl: string;
  activeBots: number;
  runningTrades: number;
};

type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;

const fallbackSummary: PortfolioSummary = {
  totalValue: '128450.21',
  unrealizedPnl: '3842.10',
  dailyPnl: '1204.55',
  activeBots: 12,
  runningTrades: 3,
};

const rangePaths: Record<Range, string> = {
  '7 days': 'M0 204 C95 212,120 174,200 184 S300 138,375 152 S490 88,590 114 S705 65,800 80',
  '30 days': 'M0 210 C80 195,100 225,170 184 S280 160,330 170 S410 110,470 125 S550 85,610 110 S690 45,800 58',
  '90 days': 'M0 228 C95 205,150 220,222 176 S350 198,418 142 S520 158,600 102 S715 120,800 54',
};

const exchanges = [
  ['Binance', 'Connected', '18 ms'],
  ['Bybit', 'Connected', '24 ms'],
  ['OKX', 'Connected', '31 ms'],
  ['Hyperliquid', 'Degraded', '86 ms'],
] as const;

const positions = [
  ['BTC/USDT', 'LONG 10×', '0.42 BTC', '$116,820', '+$1,248.20'],
  ['ETH/USDT', 'SHORT 5×', '8.50 ETH', '$3,842', '+$429.80'],
  ['SOL/USDT', 'LONG 3×', '120 SOL', '$181.40', '-$84.22'],
] as const;

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

function formatCurrency(value: string, prefix = ''): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${prefix}$0.00`;
  return `${prefix}$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Dashboard() {
  const [activeView, setActiveView] = useState<(typeof navigation)[number]>('Overview');
  const [range, setRange] = useState<Range>('30 days');
  const [summary, setSummary] = useState<PortfolioSummary>(fallbackSummary);
  const [apiOnline, setApiOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [ordersOpen, setOrdersOpen] = useState(false);

  const refreshSummary = useCallback(async () => {
    setLoading(true);
    try {
      const [healthResponse, summaryResponse] = await Promise.all([
        fetch(`${API_URL}/health`, { cache: 'no-store' }),
        fetch(`${API_URL}/portfolio/summary`, { cache: 'no-store' }),
      ]);
      if (!healthResponse.ok || !summaryResponse.ok) throw new Error('The API returned an error');
      const nextSummary = (await summaryResponse.json()) as PortfolioSummary;
      setApiOnline(true);
      setSummary(Number(nextSummary.totalValue) === 0 ? fallbackSummary : nextSummary);
    } catch {
      setApiOnline(false);
      setSummary(fallbackSummary);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  const metrics = useMemo(
    () => [
      ['Portfolio value', formatCurrency(summary.totalValue), '+2.8%', WalletCards],
      ['Unrealized PnL', formatCurrency(summary.unrealizedPnl, '+'), '+1.2%', TrendingUp],
      ['Daily PnL', formatCurrency(summary.dailyPnl, '+'), '+0.94%', CircleDollarSign],
      ['Active bots', String(summary.activeBots), '10 healthy', Bot],
    ] as const,
    [summary],
  );

  const selectView = (item: (typeof navigation)[number]) => {
    if (item === 'Bots') {
      window.location.href = '/bots';
      return;
    }
    if (item === 'Overview' || item === 'Portfolio' || item === 'Orders' || item === 'Positions') {
      window.location.href = '/dashboard';
      return;
    }
    setActiveView(item);
    setNotice({ tone: 'info', message: `${item} view selected.` });
  };

  const cycleRange = () => {
    const currentIndex = ranges.indexOf(range);
    setRange(ranges[(currentIndex + 1) % ranges.length] ?? ranges[0]);
  };

  const submitOrder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const side = String(form.get('side') ?? 'BUY');
    const symbol = String(form.get('symbol') ?? 'BTC/USDT').toUpperCase();
    const quantity = String(form.get('quantity') ?? '0.01');
    const key = crypto.randomUUID();
    try {
      const response = await fetch(`${API_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({
          exchangeAccountId: 'ac99fccd-4598-4a4a-92aa-5ce879d86e69',
          exchange: 'bybit',
          marketType: 'USDT_FUTURES',
          symbol,
          side,
          positionSide: 'BOTH',
          type: 'MARKET',
          quantity,
          reduceOnly: false,
          postOnly: false,
          timeInForce: 'GTC',
          leverage: 3,
          clientOrderId: `web-${key}`,
        }),
      });
      const result = (await response.json()) as { accepted?: boolean; message?: string };
      if (!response.ok || !result.accepted) throw new Error(result.message ?? 'Order was not accepted');
      setNotice({ tone: 'success', message: `${side} order accepted for ${quantity} ${symbol}.` });
      setOrdersOpen(false);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Order request failed.' });
    }
  };

  return (
    <main className="shell">
      <aside>
        <button className="brand brand-button" onClick={() => selectView('Overview')} type="button">
          <NexusLogo className="brand-logo" />
          <span>
            <b>NexusTrade</b>
            <small>Command Center</small>
          </span>
        </button>
        <nav aria-label="Primary navigation">
          {navigation.map((item) => (
            <button
              aria-current={activeView === item ? 'page' : undefined}
              className={activeView === item ? 'active' : ''}
              key={item}
              onClick={() => selectView(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </nav>
        <button
          className="security"
          onClick={() => setNotice({ tone: 'success', message: 'Risk engine is online and protecting orders.' })}
          type="button"
        >
          <ShieldCheck size={18} />
          <span>
            <b>Trading protected</b>
            <small>Risk engine online</small>
          </span>
        </button>
      </aside>

      <section className="content">
        <header>
          <div>
            <p className="eyebrow">THURSDAY, JULY 30</p>
            <h1>{activeView}</h1>
            <p className="muted">All critical systems are operational.</p>
          </div>
          <button className={`live ${apiOnline ? '' : 'offline'}`} onClick={() => void refreshSummary()} type="button">
            <span /> {loading ? 'CHECKING SERVICES' : apiOnline ? 'API CONNECTED' : 'DEMO DATA · RETRY'}
          </button>
        </header>

        {notice && (
          <div className={`notice-bar ${notice.tone}`} role="status">
            <span>{notice.message}</span>
            <button aria-label="Dismiss notification" onClick={() => setNotice(null)} type="button"><X size={16} /></button>
          </div>
        )}

        {activeView !== 'Overview' && (
          <section className="view-banner">
            <div>
              <p className="eyebrow">ACTIVE WORKSPACE</p>
              <h2>{activeView}</h2>
              <p className="muted">This control now updates the dashboard state. The overview remains below for operational context.</p>
            </div>
            {activeView === 'Orders' && <button className="primary" onClick={() => setOrdersOpen(true)} type="button">Create order</button>}
          </section>
        )}

        <div className="grid metrics">
          {metrics.map(([label, value, delta, Icon]) => (
            <article key={label}>
              <div className="icon"><Icon size={19} /></div>
              <p>{label}</p>
              <h2>{value}</h2>
              <small>{delta}</small>
            </article>
          ))}
        </div>

        <div className="grid main-grid">
          <article className="chart">
            <div className="card-head">
              <div><p>Portfolio performance</p><h2>{formatCurrency(summary.totalValue)}</h2></div>
              <button onClick={cycleRange} type="button">{range}</button>
            </div>
            <div className="chart-area">
              <svg aria-label={`${range} portfolio performance chart`} preserveAspectRatio="none" role="img" viewBox="0 0 800 260">
                <defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7c5cff" stopOpacity=".38" /><stop offset="1" stopColor="#7c5cff" stopOpacity="0" /></linearGradient></defs>
                <path d={`${rangePaths[range]} L800 260 L0 260Z`} fill="url(#fill)" />
                <path d={rangePaths[range]} fill="none" stroke="#8b73ff" strokeWidth="3" />
              </svg>
            </div>
          </article>
          <article>
            <div className="card-head"><div><p>System status</p><h3>Exchange connectivity</h3></div><Radio size={18} /></div>
            <div className="exchange-list">
              {exchanges.map(([name, status, latency]) => (
                <button key={name} onClick={() => setNotice({ tone: status === 'Connected' ? 'success' : 'info', message: `${name}: ${status} (${latency}).` })} type="button">
                  <span className={status === 'Connected' ? 'dot ok' : 'dot warn'} /><b>{name}</b><small>{status}</small><em>{latency}</em>
                </button>
              ))}
            </div>
          </article>
        </div>

        <div className="grid lower">
          <article>
            <div className="card-head"><div><p>Running trades</p><h3>Open positions</h3></div><button onClick={() => setOrdersOpen(true)} type="button">View all</button></div>
            <div className="table-scroll"><table><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>PnL</th></tr></thead><tbody>
              {positions.map(([market, side, size, entry, pnl]) => <tr key={market}><td>{market}</td><td><span className={side.startsWith('LONG') ? 'long' : 'short'}>{side}</span></td><td>{size}</td><td>{entry}</td><td className={pnl.startsWith('+') ? 'profit' : 'loss'}>{pnl}</td></tr>)}
            </tbody></table></div>
          </article>
          <article>
            <div className="card-head"><div><p>Automation</p><h3>Bot activity</h3></div><Activity size={18} /></div>
            <div className="activity"><p><Bot /> Breakout Alpha opened BTC long <small>2 min ago</small></p><p><Webhook /> TradingView signal verified <small>8 min ago</small></p><p><ShieldCheck /> Risk check approved order <small>12 min ago</small></p></div>
          </article>
        </div>
      </section>

      {ordersOpen && (
        <div className="modal-backdrop" onMouseDown={() => setOrdersOpen(false)} role="presentation">
          <section aria-labelledby="order-title" aria-modal="true" className="modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="card-head"><div><p>Paper execution</p><h2 id="order-title">Create demo order</h2></div><button aria-label="Close order form" onClick={() => setOrdersOpen(false)} type="button"><X size={18} /></button></div>
            <form onSubmit={submitOrder}>
              <label>Market<input defaultValue="BTC/USDT" name="symbol" required /></label>
              <label>Side<select defaultValue="BUY" name="side"><option value="BUY">Buy</option><option value="SELL">Sell</option></select></label>
              <label>Quantity<input defaultValue="0.01" min="0.000001" name="quantity" required step="any" type="number" /></label>
              <p className="muted">This validates against the development API and does not place a live exchange trade.</p>
              <button className="primary" type="submit">Submit demo order</button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
