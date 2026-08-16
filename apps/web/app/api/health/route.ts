import { NextResponse } from 'next/server';
import { prisma } from '@platform/database';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    return NextResponse.json({ status: 'ok', time: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ status: 'degraded', error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}