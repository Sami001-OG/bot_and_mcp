import { NextRequest, NextResponse } from 'next/server';
import { deleteExchangeAccount, setPrimaryAccount } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    const account = await setPrimaryAccount(id);
    return NextResponse.json({ account });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = await params;
    await deleteExchangeAccount(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}