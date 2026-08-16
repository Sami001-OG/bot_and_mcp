import { NextResponse } from 'next/server';
import { markAllNotificationsRead } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  try {
    await requireSession();
    return NextResponse.json(await markAllNotificationsRead());
  } catch (error) {
    return errorResponse(error);
  }
}