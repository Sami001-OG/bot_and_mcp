'use client';

import { Bell, Check, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/session';
import { formatTime } from '../../lib/format';
import { usePolling } from '../../hooks/usePolling';
import { useApp } from '../layout/AppContext';
import type { AppNotification } from '../../lib/types';

export function NotificationBell() {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, count] = await Promise.all([
        apiFetch<{ notifications: AppNotification[] }>('/api/notifications?take=50'),
        apiFetch<{ count: number }>('/api/notifications/unread/count'),
      ]);
      setNotifications(list.notifications);
      setUnread(count.count);
    } catch {
      /* notifications are non-critical */
    }
  }, []);

  usePolling(load, 30000);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const markRead = async (notification: AppNotification) => {
    if (notification.readAt) return;
    try {
      await apiFetch(`/api/notifications/${notification.id}/read`, { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item)));
      setUnread((count) => Math.max(0, count - 1));
    } catch {
      toast('info', 'Could not mark notification as read.');
    }
  };

  const markAllRead = async () => {
    if (unread === 0) return;
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST', body: {} });
      setNotifications((list) => list.map((item) => (item.readAt ? item : { ...item, readAt: new Date().toISOString() })));
      setUnread(0);
    } catch {
      toast('info', 'Could not mark notifications as read.');
    }
  };

  return (
    <div className="bell-wrap" ref={rootRef}>
      <button className="bell-btn" aria-label="Notifications" onClick={() => setOpen((value) => !value)} type="button">
        <Bell size={15} />
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="card-head">
            <div>
              <p className="eyebrow">NOTIFICATIONS</p>
              <h3>{unread > 0 ? `${unread} unread` : 'all read'}</h3>
            </div>
            <button className="link-button" disabled={unread === 0} onClick={() => void markAllRead()} type="button">
              Mark all read
            </button>
          </div>
          <div className="notification-list">
            {notifications.length === 0 && <p className="muted empty">No notifications yet.</p>}
            {notifications.map((notification) => (
              <div className={`notification-item ${notification.readAt ? '' : 'unread'}`} key={notification.id}>
                <div className="notification-head">
                  <span className={`severity-dot ${notification.severity.toLowerCase()}`} />
                  <b>{notification.title}</b>
                  {!notification.readAt && (
                    <button aria-label="Mark as read" className="icon-btn" onClick={() => void markRead(notification)} type="button">
                      <Check size={13} />
                    </button>
                  )}
                </div>
                {notification.message && <p className="muted small">{notification.message}</p>}
                <em className="muted small">
                  {notification.channel} / {formatTime(notification.createdAt)}
                </em>
              </div>
            ))}
          </div>
          <button aria-label="Close notifications" className="bell-close" onClick={() => setOpen(false)} type="button">
            <X size={14} /> Close
          </button>
        </div>
      )}
    </div>
  );
}