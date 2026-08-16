import { NextResponse } from 'next/server';
import { unreadNotificationCount } from '@platform/commands';
import { errorResponse } from '../../../../../lib/route';
import { requireSession } from '../../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireSession();
    return NextResponse.json({ count: await unreadNotificationCount() });
  } catch (error) {
    return errorResponse(error);
  }
}