'use client';

import { Activity, Bot, BookOpen, KeyRound, LayoutDashboard, LogOut, ShieldCheck, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { NexusLogo } from '../../app/logo';
import { checkSession, login, signOut as apiSignOut, type AuthSession } from '../../lib/session';
import { cn } from '../../lib/cn';
import { AppContext, type Toast } from './AppContext';
import { NotificationBell } from '../domain/NotificationBell';

export const NAV_ITEMS = [
  { key: 'dashboard', href: '/dashboard', label: 'Dashboard', short: 'Dashboard', icon: LayoutDashboard },
  { key: 'orders', href: '/orders', label: 'Orders', short: 'Orders', icon: BookOpen },
  { key: 'bots', href: '/bots', label: 'Bots', short: 'Bots', icon: Bot },
  { key: 'accounts', href: '/accounts', label: 'Exchange APIs', short: 'APIs', icon: KeyRound },
  { key: 'risk', href: '/risk', label: 'Risk & safety', short: 'Risk', icon: ShieldCheck },
] as const;

export type AppSection = (typeof NAV_ITEMS)[number]['key'];

export default function AppShell({ active, children }: { active: AppSection; children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [utcClock, setUtcClock] = useState('');

  useEffect(() => {
    const tick = () => setUtcClock(new Date().toISOString().slice(0, 19).replace('T', ' '));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    checkSession().then((next) => {
      setSession(next);
      setBooting(false);
    });
  }, []);

  const toast = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, tone, message }]);
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 4500);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);

  const signOut = useCallback(() => {
    void apiSignOut().finally(() => {
      setSession(null);
      setToasts([]);
    });
  }, []);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setLoginError(null);
    try {
      const next = await login(password);
      setSession(next);
      setPassword('');
      toast('success', `Signed in as ${next.email}.`);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (booting) {
    return (
      <main className="shell center-shell">
        <div className="terminal-loader">
          <Activity size={18} />
          <span>Initializing terminal</span>
        </div>
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
          <div className="login-status">
            <span className="status-pulse" /> SYSTEM ONLINE
          </div>
          <h1>Operator access</h1>
          <p className="muted">Authenticate to open the live execution terminal.</p>
          <form onSubmit={handleLogin}>
            <label>
              Password
              <input autoComplete="current-password" autoFocus minLength={8} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
            </label>
            <button className="primary" disabled={submitting} type="submit">
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          {loginError && (
            <div className="notice-bar error" role="status">
              <span>{loginError}</span>
              <button aria-label="Dismiss" onClick={() => setLoginError(null)} type="button">
                <X size={16} />
              </button>
            </div>
          )}
          <p className="muted small login-security">
            <ShieldCheck size={13} /> Encrypted session / single operator
          </p>
        </section>
      </main>
    );
  }

  const contextValue = { session, toast, signOut };

  return (
    <AppContext.Provider value={contextValue}>
      <main className="shell">
        <Sidebar active={active} email={session.email} onSignOut={signOut} />
        <section className="workspace">
          <TopBar clock={utcClock} />
          <nav className="mobile-command-bar" aria-label="Mobile navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <Link aria-current={active === item.key ? 'page' : undefined} aria-label={item.label} className={active === item.key ? 'active' : ''} href={item.href} key={item.key}>
                  <Icon size={17} />
                  <span>{item.short}</span>
                </Link>
              );
            })}
          </nav>
          <section className="content">{children}</section>
        </section>
        <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      </main>
    </AppContext.Provider>
  );
}

function Sidebar({ active, email, onSignOut }: { active: AppSection; email: string; onSignOut: () => void }) {
  return (
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
            <Link aria-current={active === item.key ? 'page' : undefined} className={cn('nav-link', active === item.key && 'active')} href={item.href} key={item.key}>
              <Icon size={15} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="security user-card">
        <div className="avatar">OWN</div>
        <span>
          <b>{email}</b>
          <small>Personal account</small>
        </span>
      </div>
      <button className="logout" onClick={onSignOut} type="button">
        <LogOut size={16} /> Sign out
      </button>
    </aside>
  );
}

function TopBar({ clock }: { clock: string }) {
  return (
    <div className="terminal-bar">
      <div>
        <span className="status-pulse" /> LIVE ENVIRONMENT
      </div>
      <span>BYBIT / USDT-M + SPOT</span>
      <span className="terminal-clock">UTC {clock}</span>
      <NotificationBell />
    </div>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((item) => (
        <div className={`toast ${item.tone}`} key={item.id} role="status">
          <span>{item.message}</span>
          <button aria-label="Dismiss" onClick={() => onDismiss(item.id)} type="button">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}