import { PrismaClient } from '../generated/client/index.js';
import { EnvelopeEncryption } from '@platform/security';

export { PrismaClient };
export * from '../generated/client/index.js';

export const prisma = new PrismaClient();

export function loadEncryption(): EnvelopeEncryption {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  return new EnvelopeEncryption(Buffer.from(keyHex, 'hex'));
}
export const encryption = loadEncryption();
