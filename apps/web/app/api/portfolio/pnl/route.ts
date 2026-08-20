import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@platform/database';
import { liveLedgerPositions, realizedPnlInWindow } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const sinceParam = request.nextUrl.searchParams.get('since');
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [ledger, realized] = await Promise.all([liveLedgerPositions(), realizedPnlInWindow(since)]);
    const openRows = ledger.rows.filter((row) => new Prisma.Decimal(row.quantity).gt(0));
    const totalUnrealized = openRows.reduce((sum, row) => sum.plus(new Prisma.Decimal(row.unrealizedPnl)), new Prisma.Decimal(0));
    const totalRealized = realized.reduce((sum, row) => sum.plus(new Prisma.Decimal(row.realizedPnl)), new Prisma.Decimal(0));
    return NextResponse.json({
      positions: openRows,
      realizedBySymbol: realized,
      totals: {
        unrealized: totalUnrealized.toFixed(4),
        realized: totalRealized.toFixed(4),
        openPositions: openRows.length,
        ledgerRows: ledger.rows.length,
      },
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
      live: ledger.live,
    });
  } catch (error) {
    return errorResponse(error);
  }
}