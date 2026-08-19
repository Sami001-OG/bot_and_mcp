import { NextRequest, NextResponse } from 'next/server';
import { createExchangeAccount, listExchangeAccounts } from '@platform/commands';
import { errorResponse } from '../../../lib/route';
import { requireSession } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireSession();
    return NextResponse.json({ accounts: await listExchangeAccounts() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const body = (await request.json().catch(() => ({}))) as { exchange?: unknown; marketType?: unknown; label?: unknown; apiKey?: unknown; secret?: unknown; testnet?: unknown };
    if (typeof body.exchange !== 'string' || typeof body.marketType !== 'string') {
      return NextResponse.json({ message: 'exchange and marketType are required', code: 'VALIDATION_ERROR' }, { status: 400 });
    }
    if (typeof body.apiKey !== 'string' || typeof body.secret !== 'string') {
      return NextResponse.json({ message: 'apiKey and secret are required', code: 'VALIDATION_ERROR' }, { status: 400 });
    }
    const account = await createExchangeAccount({
      exchange: body.exchange,
      marketType: body.marketType,
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
      apiKey: body.apiKey,
      secret: body.secret,
      testnet: body.testnet === true,
    });
    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}