import { NextRequest, NextResponse } from 'next/server';
import { CommandError, processWebhookSignal } from '@platform/commands';
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
  try {
    const result = await processWebhookSignal({ endpointId, rawBody, signature });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof CommandError && error.statusCode < 500) {
      return errorResponse(error);
    }
    if (error instanceof Error && /Invalid webhook signature|timestamp outside tolerance|replay detected/.test(error.message)) {
      return NextResponse.json({ message: error.message, code: 'WEBHOOK_VERIFICATION_FAILED' }, { status: 401 });
    }
    return errorResponse(error);
  }
}