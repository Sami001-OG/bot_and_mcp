import { NextRequest, NextResponse } from 'next/server';
import { setBotStatus, type BotStatus } from '@platform/commands';
import { errorResponse } from '../../../../../lib/route';
import { requireSession } from '../../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS: ReadonlyArray<BotStatus> = ['PAUSED', 'ACTIVE', 'STOPPED'];

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }): Promise<NextResponse> {
  try {
    await requireSession();
    const { id, action } = await params;
    const status = action.toUpperCase();
    if (!ACTIONS.includes(status as BotStatus)) {
      return NextResponse.json({ message: `Unknown bot action: ${action}` }, { status: 400 });
    }
    return NextResponse.json(await setBotStatus({ botId: id, status: status as BotStatus }));
  } catch (error) {
    return errorResponse(error);
  }
}