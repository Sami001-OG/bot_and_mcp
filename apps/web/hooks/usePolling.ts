'use client';

import { useEffect, useRef } from 'react';

export function usePolling(fn: () => void | Promise<void>, intervalMs: number, deps: unknown[] = [], enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) void fnRef.current();
    };
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) void fnRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled, ...deps]);
}