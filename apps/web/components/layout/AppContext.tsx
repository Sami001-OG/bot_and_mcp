'use client';

import { createContext, useContext } from 'react';
import type { AuthSession } from '../../lib/session';

export type Toast = { id: number; tone: 'success' | 'error' | 'info'; message: string };

export type AppContextValue = {
  session: AuthSession | null;
  toast: (tone: Toast['tone'], message: string) => void;
  signOut: () => void;
};

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppShell');
  return ctx;
}