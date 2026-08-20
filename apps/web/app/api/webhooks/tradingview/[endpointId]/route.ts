import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { CommandError, executeWebhookSignal, verifyWebhookSignal } from '@platform/commands';
import { errorResponse } from '../../../../../lib/route';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ endpointId: string }> }): Promise<NextResponse> {
  const { endpointId } = await params;
  const rawBody = await request.text();
  const signature = request.headers.get('x-tradingview-signature') ?? '';
  const requireSignature = process.env.WEBHOOK_REQUIRE_SIGNATURE !== 'false';
  if (requireSignature && !signature) {
    return NextResponse.json({ message: 'Missing x-tradingview-signature header' }, { status: 401 });
  }
  let verified: { deliveryId: string; signal: import('@platform/contracts').TradingViewSignal };
  try {
    const result = await verifyWebhookSignal({ endpointId, rawBody, signature });
    verified = result;
  } catch (error) {
    if (error instanceof CommandError && error.statusCode < 500) {
      return errorResponse(error);
    }
    if (error instanceof Error && /Invalid webhook signature|timestamp outside tolerance|replay detected/.test(error.message)) {
      return NextResponse.json({ message: error.message, code: 'WEBHOOK_VERIFICATION_FAILED' }, { status: 401 });
    }
    return errorResponse(error);
  }
  after(async () => {
    try {
      await executeWebhookSignal({ deliveryId: verified.deliveryId, endpointId, signal: verified.signal });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'webhook-execute', endpointId, deliveryId: verified.deliveryId, error: error instanceof Error ? error.message : String(error) }));
    }
  });
  return NextResponse.json({ deliveryId: verified.deliveryId, status: 'ACCEPTED' }, { status: 202 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}