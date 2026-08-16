import { prisma, Prisma } from '@platform/database';

export type NotificationInput = { channel: string; severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'; title: string; message?: string; payload?: unknown };

export async function createNotification(input: NotificationInput): Promise<{ notificationId: string; deduped: boolean }> {
  const { channel, severity, title, message, payload } = input;
  const duplicate = await prisma.notification.findFirst({ where: { channel, title, createdAt: { gte: new Date(Date.now() - 30_000) } }, orderBy: { createdAt: 'desc' } });
  if (duplicate) return { notificationId: duplicate.id, deduped: true };
  const created = await prisma.notification.create({ data: { channel, severity, title, ...(message ? { message } : {}), ...(payload ? { payload: payload as Prisma.InputJsonValue } : {}) } });
  return { notificationId: created.id, deduped: false };
}

export function queueNotification(input: NotificationInput): Promise<{ notificationId: string; deduped: boolean }> {
  return createNotification(input).catch(() => ({ notificationId: '', deduped: true }));
}

export async function listNotifications(take = 100) {
  return prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take });
}

export async function unreadNotificationCount(): Promise<number> {
  return prisma.notification.count({ where: { readAt: null } });
}

export async function markNotificationRead(id: string): Promise<{ id: string; readAt: Date }> {
  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification) throw new Error('NOT_FOUND');
  const updated = await prisma.notification.update({ where: { id }, data: { readAt: notification.readAt ?? new Date() } });
  return { id: updated.id, readAt: updated.readAt as Date };
}

export async function markAllNotificationsRead(): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
  return { updated: result.count };
}