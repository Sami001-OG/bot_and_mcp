import { NextRequest, NextResponse } from 'next/server';
import { portfolioSummary } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const marketType = request.nextUrl.searchParams.get('marketType') ?? undefined;
    return NextResponse.json(await portfolioSummary(marketType));
  } catch (error) {
    return errorResponse(error);
  }
}