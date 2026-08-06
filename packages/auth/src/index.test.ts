import { describe, expect, it } from 'vitest';
import { createAccessToken, generateRefreshToken, hashPassword, hashRefreshToken, verifyAccessToken, verifyPassword } from './index.js';

process.env.JWT_ACCESS_SECRET = 'test-secret-with-at-least-32-characters!!';

describe('auth', () => {
  it('hashes and verifies passwords', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('rejects malformed stored hashes', () => {
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('signs and verifies access tokens', async () => {
    const token = await createAccessToken({ userId: 'u1', workspaceId: 'w1', email: 'a@b.c', role: 'OWNER' });
    const claims = await verifyAccessToken(token);
    expect(claims).toEqual({ userId: 'u1', workspaceId: 'w1', email: 'a@b.c', role: 'OWNER' });
    expect(await verifyAccessToken(`${token.slice(0, -2)}xx`)).toBeNull();
  });

  it('generates opaque refresh tokens with deterministic hashes', () => {
    const token = generateRefreshToken();
    expect(token.length).toBeGreaterThanOrEqual(60);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toBe(token);
  });
});
