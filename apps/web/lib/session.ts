'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const SESSION_KEY = 'nexus.session';

export type AuthSession = {
  user: { id: string; email: string; name: string | null };
  workspace: { id: string; name: string } | null;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export class ApiHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function loadSession(): AuthSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  window.localStorage.removeItem(SESSION_KEY);
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new ApiHttpError(await unwrapError(response), response.status);
  const session = (await response.json()) as AuthSession;
  saveSession(session);
  return session;
}

async function unwrapError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string; issues?: unknown[]; statusCode?: number };
    if (Array.isArray(data.issues) && data.issues.length > 0) {
      const first = data.issues[0] as { path?: string[]; message?: string };
      return `${first?.message ?? 'Validation failed'}${first?.path?.length ? ` (${first.path.join('.')})` : ''}`;
    }
    if (typeof data.message === 'string') return data.message;
  } catch {
    /* non-json body */
  }
  return `Request failed (${response.status})`;
}

export async function apiFetch<T>(
  path: string,
  session: AuthSession | null,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  const method = options.method ?? 'GET';
  const init: RequestInit = { method, headers, ...(method === 'GET' ? { cache: 'no-store' } : {}) };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) throw new ApiHttpError(await unwrapError(response), response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}