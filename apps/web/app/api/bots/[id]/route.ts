import { NextRequest, NextResponse } from 'next/server';
import { deleteBotsByIds, getBot, updateBotConfig } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    return NextResponse.json({ bot: await getBot(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { config?: unknown };
    const bot = await updateBotConfig({ botId: id, config: body.config });
    return NextResponse.json({ bot });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    return NextResponse.json(await deleteBotsByIds([id]));
  } catch (error) {
    return errorResponse(error);
  }
}