import { PrismaClient } from '../../../apps/web/prisma/generated/client/index.js';

export { PrismaClient };
export * from '../../../apps/web/prisma/generated/client/index.js';

export const prisma = new PrismaClient();