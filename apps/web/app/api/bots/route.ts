import { NextRequest, NextResponse } from 'next/server';
import { createBot, listBots } from '@platform/commands';
import { errorResponse } from '../../../lib/route';
import { requireSession } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireSession();
    return NextResponse.json({ bots: await listBots() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; exchangeAccountId?: unknown; config?: unknown };
    if (typeof body.exchangeAccountId !== 'string' || body.exchangeAccountId.trim() === '') {
      return NextResponse.json({ message: 'exchangeAccountId is required. Every bot must be created with an exchange API.', code: 'VALIDATION_ERROR' }, { status: 400 });
    }
    const result = await createBot({ name: String(body.name ?? ''), exchangeAccountId: body.exchangeAccountId, config: body.config });
    return NextResponse.json({ bot: result.bot, webhook: result.webhook }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}