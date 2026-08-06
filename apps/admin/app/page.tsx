'use client';

import { Activity, AlertTriangle, Database, Power, RotateCw, Server, Shield, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';

type HealthState = 'checking' | 'operational' | 'degraded';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export default function Admin() {
  const [killSwitchOpen, setKillSwitchOpen] = useState(false);
  const [tradingHalted, setTradingHalted] = useState(false);
  const [health, setHealth] = useState<HealthState>('checking');
  const [message, setMessage] = useState('');

  const checkHealth = async () => {
    setHealth('checking');
    try {
      const response = await fetch(`${API_URL}/health`, { cache: 'no-store' });
      if (!response.ok) throw new Error('API is unavailable');
      setHealth('operational');
      setMessage('Service health refreshed successfully.');
    } catch {
      setHealth('degraded');
      setMessage('API health check failed. Dashboard remains in safe monitoring mode.');
    }
  };

  useEffect(() => {
    void checkHealth();
  }, []);

  const stats = [
    ['Active users', '8,429', Users],
    ['Orders / min', tradingHalted ? '0' : '18,204', Activity],
    ['Queue depth', tradingHalted ? '0' : '1,284', Database],
    ['API p95', health === 'operational' ? '87 ms' : 'Unavailable', Server],
  ] as const;

  const confirmKillSwitch = async () => {
    try {
      const response = await fetch(`${API_URL}/orders/emergency/close-all`, { method: 'POST' });
      if (!response.ok) throw new Error('Emergency command was rejected');
      setTradingHalted(true);
      setMessage('Emergency close-all command accepted. Demo trading is halted.');
    } catch {
      setMessage('API unavailable: local admin state is halted, but no backend command was confirmed.');
      setTradingHalted(true);
    } finally {
      setKillSwitchOpen(false);
    }
  };

  const services = ['API gateway', 'Order workers', 'Webhook ingress', 'Market data', 'MCP server', 'PostgreSQL', 'Redis'];

  return (
    <main className="admin">
      <header>
        <div className="admin-brand"><img alt="NexusTrade" height="48" src="/icon.svg" width="48" /><div><p className="eyebrow">NEXUSTRADE ADMINISTRATION</p><h1>Operations console</h1><p className="muted">Global system, security, and exchange oversight.</p></div></div>
        <div className="header-actions">
          <button className="secondary" onClick={() => void checkHealth()} type="button"><RotateCw size={16} /> Refresh</button>
          <button className={tradingHalted ? 'safe' : 'danger'} disabled={tradingHalted} onClick={() => setKillSwitchOpen(true)} type="button"><Shield size={16} /> {tradingHalted ? 'Trading halted' : 'Global kill switch'}</button>
        </div>
      </header>

      {message && <div className="notice-bar" role="status"><span>{message}</span><button aria-label="Dismiss notification" onClick={() => setMessage('')} type="button"><X size={16} /></button></div>}

      <section className="grid metrics">
        {stats.map(([label, value, Icon]) => <article key={label}><div className="icon"><Icon size={19} /></div><p>{label}</p><h2>{value}</h2></article>)}
      </section>

      <section className="grid admin-grid">
        <article><div className="card-head"><h3>Service health</h3><span className={`status-label ${health}`}>{health}</span></div>{services.map((service, index) => {
          const degraded = index === 3 || (index === 0 && health === 'degraded');
          return <button className="health" key={service} onClick={() => setMessage(`${service}: ${degraded ? 'degraded and under observation' : 'operational'}.`)} type="button"><span className={degraded ? 'dot warn' : 'dot ok'} /><b>{service}</b><small>{degraded ? 'Degraded' : 'Operational'}</small><em>{degraded ? 'Elevated lag' : 'Healthy'}</em></button>;
        })}</article>
        <article><h3>Security events</h3><button className="notice" onClick={() => setMessage('23 blocked login attempts reviewed. No account takeover detected.')} type="button"><AlertTriangle /><span><b>Repeated login failures</b><p>23 attempts blocked across 4 IP addresses.</p><small>4 minutes ago</small></span></button><button className="notice" onClick={() => setMessage('Revocation record agent-prod-7 opened for review.')} type="button"><Shield /><span><b>MCP grant revoked</b><p>Client agent-prod-7 was revoked by workspace owner.</p><small>18 minutes ago</small></span></button></article>
      </section>

      <section className="grid admin-grid">
        <article><h3>Exchange traffic</h3><div className="table-scroll"><table><thead><tr><th>Exchange</th><th>Requests/min</th><th>Error rate</th><th>p95</th></tr></thead><tbody>{[['Binance','42,120','0.08%','41 ms'],['Bybit','18,440','0.11%','62 ms'],['OKX','9,870','0.06%','58 ms'],['Hyperliquid','6,212','1.24%','112 ms']].map((row) => <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}</tbody></table></div></article>
        <article><h3>Incident queue</h3><p className="empty">No critical incidents. One degraded market-data stream is being retried automatically.</p></article>
      </section>

      {killSwitchOpen && <div className="modal-backdrop" onMouseDown={() => setKillSwitchOpen(false)} role="presentation"><section aria-labelledby="kill-title" aria-modal="true" className="modal" onMouseDown={(event) => event.stopPropagation()} role="alertdialog"><div className="modal-icon"><Power /></div><h2 id="kill-title">Activate global kill switch?</h2><p className="muted">This sends the development close-all command and halts the local dashboard state. It cannot place or close real exchange orders in this foundation build.</p><div className="modal-actions"><button className="secondary" onClick={() => setKillSwitchOpen(false)} type="button">Cancel</button><button className="danger" onClick={() => void confirmKillSwitch()} type="button">Confirm emergency halt</button></div></section></div>}
    </main>
  );
}
