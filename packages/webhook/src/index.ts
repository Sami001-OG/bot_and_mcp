import { createHmac } from 'node:crypto';
import { TradingViewSignalSchema, type TradingViewSignal } from '@platform/contracts';
import { constantTimeEqual } from '@platform/security';
export type ReplayStore = { claim(key: string, ttlSeconds: number): Promise<boolean> };
export class TradingViewWebhookVerifier {
  constructor(private readonly secret: string, private readonly replayStore: ReplayStore, private readonly toleranceMs = 5 * 60_000) {}
  async verify(rawBody: string, signature: string, now = Date.now()): Promise<TradingViewSignal> {
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    if (!constantTimeEqual(expected, signature)) throw new Error('Invalid webhook signature');
    const signal = TradingViewSignalSchema.parse(JSON.parse(rawBody));
    if (Math.abs(now - Date.parse(signal.timestamp)) > this.toleranceMs) throw new Error('Webhook timestamp outside tolerance');
    if (!(await this.replayStore.claim(`${signal.exchange}:${signal.nonce}`, Math.ceil(this.toleranceMs / 1000)))) throw new Error('Webhook replay detected');
    return signal;
  }
}
