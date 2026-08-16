import { NextRequest, NextResponse } from 'next/server';
import { closeAllNow } from '@platform/commands';
import { errorResponse } from '../../../../../lib/route';
import { requireSession } from '../../../../../lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    return NextResponse.json(await closeAllNow());
  } catch (error) {
    return errorResponse(error);
  }
}