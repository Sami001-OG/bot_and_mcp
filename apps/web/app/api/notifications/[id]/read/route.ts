import { NextRequest, NextResponse } from 'next/server';
import { markNotificationRead } from '@platform/commands';
import { errorResponse } from '../../../../../lib/route';
import { requireSession } from '../../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    return NextResponse.json(await markNotificationRead(id));
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ message: 'Notification not found', code: 'NOT_FOUND' }, { status: 404 });
    }
    return errorResponse(error);
  }
}