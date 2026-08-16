import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@platform/database';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    const order = await prisma.orderIntent.findUnique({ where: { id }, include: { executions: true } });
    if (!order) return NextResponse.json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ order });
  } catch (error) {
    return errorResponse(error);
  }
}