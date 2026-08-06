import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export type AuthClaims = { userId: string; workspaceId: string; email: string; role: string };

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: n, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function accessSecret(): Uint8Array {
  const value = process.env.JWT_ACCESS_SECRET;
  if (!value || value.length < 32) throw new Error('JWT_ACCESS_SECRET must be set and at least 32 characters');
  return new TextEncoder().encode(value);
}

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export async function createAccessToken(claims: AuthClaims): Promise<string> {
  return new SignJWT({ wsid: claims.workspaceId, email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret());
}

export async function verifyAccessToken(token: string): Promise<AuthClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessSecret(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.wsid !== 'string') return null;
    return {
      userId: payload.sub,
      workspaceId: payload.wsid,
      email: typeof payload.email === 'string' ? payload.email : '',
      role: typeof payload.role === 'string' ? payload.role : 'MEMBER'
    };
  } catch {
    return null;
  }
}

export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
