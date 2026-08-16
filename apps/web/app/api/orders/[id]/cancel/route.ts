import { NextRequest, NextResponse } from 'next/server';
import { cancelOrderCommand } from '@platform/commands';
import { errorResponse } from '../../../../../lib/route';
import { requireSession } from '../../../../../lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    return NextResponse.json(await cancelOrderCommand(id));
  } catch (error) {
    return errorResponse(error);
  }
}