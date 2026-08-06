import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type EncryptedEnvelope = { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string; keyId: string };
export class EnvelopeEncryption {
  constructor(private readonly masterKey: Buffer, private readonly keyId = 'local-v1') { if (masterKey.length !== 32) throw new Error('Master key must be exactly 32 bytes'); }
  encrypt(plaintext: string, context: string): EncryptedEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), keyId: this.keyId };
  }
  decrypt(envelope: EncryptedEnvelope, context: string): string {
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}
export function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function constantTimeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|token|password|private.?key|api.?key/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
