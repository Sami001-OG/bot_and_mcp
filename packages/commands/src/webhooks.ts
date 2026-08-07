import { randomUUID } from 'node:crypto';
import { encryption, prisma, type Prisma } from '@platform/database';
import { hashToken } from '@platform/security';

export async function createWebhookEndpoint(input: { workspaceId: string; name: string }) {
  const { workspaceId, name } = input;
  const token = `wh_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
  const signingSecret = randomUUID();
  const endpoint = await prisma.webhookEndpoint.create({
    data: { workspaceId, name, tokenHash: hashToken(token), encryptedSigningSecret: encryption.encrypt(signingSecret, `webhook-endpoint:${workspaceId}`) }
  });
  return { id: endpoint.id, name: endpoint.name, token, signingSecret, url: `POST /api/v1/webhooks/tradingview/${endpoint.id}` };
}

export async function listWebhookEndpoints(workspaceId: string): Promise<Prisma.WebhookEndpointGetPayload<{ include: { _count: { select: { deliveries: true } } } }>[]> {
  return prisma.webhookEndpoint.findMany({ where: { workspaceId }, include: { _count: { select: { deliveries: true } } } });
}
