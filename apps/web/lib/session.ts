'use client';

export function getApiBaseUrl(): string {
  return '';
}

export type AuthSession = { email: string };

export class ApiHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function checkSession(): Promise<AuthSession | null> {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = (await response.json()) as { authenticated: boolean; email?: string };
    return data.authenticated ? { email: data.email ?? 'owner' } : null;
  } catch {
    return null;
  }
}

export async function login(password: string): Promise<AuthSession> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new ApiHttpError(await unwrapError(response), response.status);
  const data = (await response.json()) as { email?: string };
  return { email: data.email ?? 'owner' };
}

export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
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
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  const method = options.method ?? 'GET';
  const init: RequestInit = { method, headers, credentials: 'same-origin', ...(method === 'GET' ? { cache: 'no-store' } : {}) };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${getApiBaseUrl()}${path}`, init);
  if (!response.ok) throw new ApiHttpError(await unwrapError(response), response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}