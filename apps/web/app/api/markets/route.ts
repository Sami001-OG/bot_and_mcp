import { NextRequest, NextResponse } from 'next/server';
import { listExchangeMarkets } from '@platform/commands';
import { errorResponse } from '../../../lib/route';
import { requireSession } from '../../../lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const quote = request.nextUrl.searchParams.get('quote') ?? undefined;
    const markets = await listExchangeMarkets(quote);
    return NextResponse.json({ count: markets.length, quote: quote ?? '*', symbols: markets });
  } catch (error) {
    return errorResponse(error);
  }
}