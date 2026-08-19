import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { checkCircuitBreaker, runAllBotManagement, scanForStaleOrders, syncPositionsNow } from '@platform/commands';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function verifyCronSecret(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const left = Buffer.from(provided ?? '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const provided = request.headers.get('x-cron-secret') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ message: 'Cron is not configured (CRON_SECRET missing)' }, { status: 503 });
  }
  if (!verifyCronSecret(provided)) {
    return NextResponse.json({ message: 'Invalid cron secret' }, { status: 401 });
  }
  const results: Record<string, unknown> = { ranAt: new Date().toISOString() };
  try {
    const [breaker, stale, positions, management] = await Promise.all([
      checkCircuitBreaker().catch((error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) })),
      scanForStaleOrders().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
      syncPositionsNow().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
      runAllBotManagement().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    ]);
    results.breaker = breaker;
    results.stale = stale;
    results.positions = positions;
    results.management = management;
    return NextResponse.json(results);
  } catch (error) {
    results.error = error instanceof Error ? error.message : String(error);
    return NextResponse.json(results, { status: 500 });
  }
}