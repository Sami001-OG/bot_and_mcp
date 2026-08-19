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
    const type = request.nextUrl.searchParams.get('type') ?? undefined;
    const markets = await listExchangeMarkets(quote, type);
    return NextResponse.json({ count: markets.length, quote: quote ?? '*', type: type ?? '*', symbols: markets });
  } catch (error) {
    return errorResponse(error);
  }
}