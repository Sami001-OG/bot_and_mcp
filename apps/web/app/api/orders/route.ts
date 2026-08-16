import { NextRequest, NextResponse } from 'next/server';
import { listOrders, parseOrderBody, placeOrder } from '@platform/commands';
import { errorResponse } from '../../../lib/route';
import { requireSession } from '../../../lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const take = Math.min(Math.max(Number(request.nextUrl.searchParams.get('take') ?? 100), 1), 500);
    return NextResponse.json({ orders: await listOrders(take) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const body = await request.json().catch(() => ({}));
    const parsed = await parseOrderBody(body);
    const result = await placeOrder({ request: parsed });
    return NextResponse.json(result, { status: result.accepted ? 201 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}