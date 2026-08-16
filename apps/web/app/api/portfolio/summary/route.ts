import { NextResponse } from 'next/server';
import { portfolioSummary } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireSession();
    return NextResponse.json(await portfolioSummary());
  } catch (error) {
    return errorResponse(error);
  }
}