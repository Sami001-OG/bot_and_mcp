import { PrismaClient } from '../generated/client/index.js';
import { EnvelopeEncryption } from '@platform/security';

export { PrismaClient };
export * from '../generated/client/index.js';

export const prisma = new PrismaClient();

export function loadEncryption(): EnvelopeEncryption {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is required');
  const keyBytes = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  return new EnvelopeEncryption(keyBytes);
}
export const encryption = loadEncryption();
