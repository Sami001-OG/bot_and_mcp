import { NextRequest, NextResponse } from 'next/server';
import { listExecutions } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const take = Math.min(Math.max(Number(request.nextUrl.searchParams.get('take') ?? 100), 1), 500);
    return NextResponse.json({ executions: await listExecutions(take) });
  } catch (error) {
    return errorResponse(error);
  }
}