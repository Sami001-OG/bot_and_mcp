'use client';

import { Activity, Bot, BookOpen, KeyRound, LayoutDashboard, LogOut, Radio, ShieldCheck, Webhook, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { NexusLogo } from '../logo';
import { checkSession, login, signOut, type AuthSession } from '../../lib/session';

export type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;

export type ShellContext = {
  session: AuthSession;
  notice: Notice;
  setNotice: (notice: Notice) => void;
  signOut: () => void;
};

export const NAV_ITEMS = [
  { key: 'dashboard', href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'orders', href: '/orders', label: 'Orders', icon: BookOpen },
  { key: 'bots', href: '/bots', label: 'Bots', icon: Bot },
  { key: 'webhooks', href: '/webhooks', label: 'Webhooks', icon: Webhook },
  { key: 'accounts', href: '/accounts', label: 'Exchange APIs', icon: KeyRound },
] as const;

export type AppSection = (typeof NAV_ITEMS)[number]['key'];

export default function AppShell({
  active,
  children,
}: {
  active: AppSection;
  children: (context: ShellContext) => React.ReactNode;
}) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    checkSession().then((next) => {
      setSession(next);
      setBooting(false);
    });
  }, []);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const next = await login(password);
      setSession(next);
      setPassword('');
      setNotice({ tone: 'success', message: `Signed in as ${next.email}.` });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Login failed.' });
    } finally {
      setSubmitting(false);
    }
  };

  const logout = () => {
    void signOut().finally(() => {
      setSession(null);
      setNotice(null);
    });
  };

  if (booting) {
    return (
      <main className="shell center-shell">
        <div className="terminal-loader"><Activity size={18} /><span>Initializing terminal</span></div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="login-brand">
            <NexusLogo className="brand-logo" />
            <div>
              <b>NexusTrade</b>
              <small>Bybit execution terminal</small>
            </div>
          </div>
          <div className="login-status"><span className="status-pulse" /> SYSTEM ONLINE</div>
          <h1>Operator access</h1>
          <p className="muted">Authenticate to open the live execution terminal.</p>
          <form onSubmit={handleLogin}>
            <label>
              Password
              <input autoComplete="current-password" minLength={8} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
            </label>
            <button className="primary" disabled={submitting} type="submit">
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          {notice && (
            <div className={`notice-bar ${notice.tone}`} role="status">
              <span>{notice.message}</span>
              <button aria-label="Dismiss" onClick={() => setNotice(null)} type="button">
                <X size={16} />
              </button>
            </div>
          )}
          <p className="muted small login-security"><ShieldCheck size={13} /> Encrypted session / single operator</p>
        </section>
      </main>
    );
  }

  const context: ShellContext = { session, notice, setNotice, signOut: logout };

  return (
    <main className="shell">
      <aside>
        <Link className="brand brand-button" href="/">
          <NexusLogo className="brand-logo" />
          <span>
            <b>NexusTrade</b>
            <small>Execution terminal</small>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link className={`nav-link${active === item.key ? ' active' : ''}`} href={item.href} key={item.key}>
                <Icon size={15} /> {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="system-stack" aria-label="System status">
          <p>System status</p>
          <div><span className="status-pulse" /><b>Execution API</b><small>Operational</small></div>
          <div><Radio size={13} /><b>Bybit mainnet</b><small>Connected</small></div>
        </div>
        <div className="security user-card">
          <div className="avatar">OWN</div>
          <span>
            <b>{session.email}</b>
            <small>Personal account</small>
          </span>
        </div>
        <button className="logout" onClick={logout} type="button">
          <LogOut size={16} /> Sign out
        </button>
      </aside>
      <section className="workspace">
        <div className="terminal-bar">
          <div><span className="status-pulse" /> LIVE ENVIRONMENT</div>
          <span>BYBIT / USDT-M + SPOT</span>
          <span className="terminal-clock">SECURE OPERATOR SESSION</span>
        </div>
        <nav className="mobile-command-bar" aria-label="Mobile navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return <Link aria-label={item.label} className={active === item.key ? 'active' : ''} href={item.href} key={item.key}><Icon size={17} /><span>{item.label}</span></Link>;
          })}
        </nav>
        <section className="content">
        {notice && (
          <div className={`notice-bar ${notice.tone}`} role="status">
            <span>{notice.message}</span>
            <button aria-label="Dismiss notification" onClick={() => setNotice(null)} type="button">
              <X size={16} />
            </button>
          </div>
        )}
        {children(context)}
        </section>
      </section>
    </main>
  );
}
