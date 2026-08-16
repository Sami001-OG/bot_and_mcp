import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'nx_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sessionSecret(): Buffer {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 16) throw new Error('SESSION_SECRET must be set (>= 16 chars)');
  return Buffer.from(raw);
}

export function signSession(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts as [string, string];
  const expected = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number };
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

export async function requireSession(): Promise<void> {
  const store = await cookies();
  if (!verifySession(store.get(SESSION_COOKIE)?.value)) {
    throw new Error('UNAUTHORIZED');
  }
}

export function checkPassword(password: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  const left = Buffer.from(String(password));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}