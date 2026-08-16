import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, redact } from './index.js';

describe('security', () => {
  it('round-trips encrypted secrets', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const encrypted = encryptSecret('super-secret-key');
    expect(encrypted).not.toContain('super-secret-key');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(decryptSecret(encrypted)).toBe('super-secret-key');
  });
  it('produces unique ciphertext per call', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });
  it('accepts a 32-byte base64 key', () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const encrypted = encryptSecret('key');
    expect(decryptSecret(encrypted)).toBe('key');
  });
  it('redacts nested secrets', () => expect(redact({ apiKey: 'x', nested: { token: 'y', safe: 'z' } })).toEqual({ apiKey: '[REDACTED]', nested: { token: '[REDACTED]', safe: 'z' } }));
});