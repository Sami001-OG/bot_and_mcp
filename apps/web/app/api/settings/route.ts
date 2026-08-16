import { NextRequest, NextResponse } from 'next/server';
import { dailyRealizedPnl, getAccountConfig, getSettings, listExchangeAccounts, setDailyLossLimit, setTradingEnabled } from '@platform/commands';
import { errorResponse } from '../../../lib/route';
import { requireSession } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const settings = await getSettings();
    const config = await getAccountConfig();
    const accounts = await listExchangeAccounts();
    const host = request.headers.get('host') ?? 'localhost:3000';
    const protocol = request.headers.get('x-forwarded-proto') ?? 'http';
    return NextResponse.json({
      tradingEnabled: settings.tradingEnabled,
      liveTradingAcknowledgedAt: settings.liveTradingAcknowledgedAt,
      dailyLossLimit: settings.dailyLossLimit,
      dailyRealizedPnl: await dailyRealizedPnl(),
      equity: settings.equity,
      peakEquity: settings.peakEquity,
      breakerTripped: settings.breakerTripped,
      breakerReason: settings.breakerReason,
      breakerDailyPnl: settings.breakerDailyPnl,
      exchange: config.exchange,
      marketType: config.marketType,
      accountLabel: config.label,
      accountId: config.id,
      accounts,
      mcpUrl: `${protocol}://${host}/api/mcp`,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();
    const body = (await request.json().catch(() => ({}))) as { tradingEnabled?: unknown; dailyLossLimit?: unknown };
    let result: { tradingEnabled?: boolean; liveTradingAcknowledgedAt?: Date | null; dailyLossLimit?: string | null } = {};
    if (typeof body.tradingEnabled === 'boolean') {
      result = { ...result, ...(await setTradingEnabled(body.tradingEnabled)) };
    }
    if (body.dailyLossLimit !== undefined) {
      const limit = typeof body.dailyLossLimit === 'string' && body.dailyLossLimit.trim() !== '' ? body.dailyLossLimit.trim() : null;
      if (limit !== null && (Number.isNaN(Number(limit)) || Number(limit) <= 0)) {
        return NextResponse.json({ message: 'dailyLossLimit must be a positive number or empty', code: 'VALIDATION_ERROR' }, { status: 400 });
      }
      result = { ...result, ...(await setDailyLossLimit(limit)) };
    }
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}