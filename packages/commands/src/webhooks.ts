import { randomUUID } from 'node:crypto';
import { prisma } from '@platform/database';

export async function createWebhookEndpoint(input: { name: string }) {
  const { name } = input;
  const signingSecret = randomUUID();
  const endpoint = await prisma.webhookEndpoint.create({ data: { name, signingSecret } });
  return { id: endpoint.id, name: endpoint.name, signingSecret, url: `POST /api/webhooks/tradingview/${endpoint.id}` };
}

export async function listWebhookEndpoints() {
  return prisma.webhookEndpoint.findMany({ include: { _count: { select: { deliveries: true } } }, orderBy: { createdAt: 'desc' } });
}