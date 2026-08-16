import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@platform/database';
import { listLedgerPositions, realizedPnlInWindow } from '@platform/commands';
import { errorResponse } from '../../../../lib/route';
import { requireSession } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const sinceParam = request.nextUrl.searchParams.get('since');
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [rows, realized] = await Promise.all([listLedgerPositions(), realizedPnlInWindow(since)]);
    const totalUnrealized = rows
      .filter((row) => new Prisma.Decimal(row.quantity).gt(0))
      .reduce((sum, row) => sum.plus(new Prisma.Decimal(row.unrealizedPnl)), new Prisma.Decimal(0));
    const totalRealized = realized.reduce((sum, row) => sum.plus(new Prisma.Decimal(row.realizedPnl)), new Prisma.Decimal(0));
    return NextResponse.json({
      positions: rows,
      realizedBySymbol: realized,
      totals: {
        unrealized: totalUnrealized.toFixed(4),
        realized: totalRealized.toFixed(4),
        openPositions: rows.filter((row) => new Prisma.Decimal(row.quantity).gt(0)).length,
        ledgerRows: rows.length,
      },
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}