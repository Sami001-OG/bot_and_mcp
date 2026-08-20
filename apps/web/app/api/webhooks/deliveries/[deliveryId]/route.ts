import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@platform/database';
import { requireSession } from '../../../../../lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ deliveryId: string }> }): Promise<NextResponse> {
  await requireSession();
  const { deliveryId } = await params;
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) return NextResponse.json({ message: 'Delivery not found' }, { status: 404 });
  return NextResponse.json(delivery);
}