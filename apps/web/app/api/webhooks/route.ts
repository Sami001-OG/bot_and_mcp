import { NextRequest, NextResponse } from 'next/server';
import { createWebhookEndpoint, listWebhookEndpoints } from '@platform/commands';
import { errorResponse } from '../../../lib/route';
import { requireSession } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireSession();
    return NextResponse.json({ endpoints: await listWebhookEndpoints() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    const name = String(body.name ?? '').trim();
    if (!name) return NextResponse.json({ message: 'name is required', code: 'VALIDATION_ERROR' }, { status: 400 });
    return NextResponse.json(await createWebhookEndpoint({ name }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}