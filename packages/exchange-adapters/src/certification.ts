import type { ExchangeCredentials } from '@platform/exchange-core';
import type { ExchangeAdapter } from '@platform/exchange-core';

export type CertificationCheck = { name: string; status: 'PASS' | 'SKIP' | 'FAIL'; detail?: string };
export type CertificationResult = { passed: boolean; serverTimeSkewMs?: number; checks: CertificationCheck[] };

const MAX_ALLOWED_CLOCK_SKEW_MS = 300_000;

function check(name: string, status: CertificationCheck['status'], detail?: string): CertificationCheck {
  const result: CertificationCheck = { name, status };
  if (detail !== undefined) result.detail = detail;
  return result;
}

export async function runReadOnlyCertification(adapter: ExchangeAdapter, credentials: ExchangeCredentials): Promise<CertificationResult> {
  const checks: CertificationCheck[] = [];
  let serverTimeSkewMs: number | undefined;

  try {
    const connection = await adapter.connect(credentials);
    serverTimeSkewMs = Math.abs(new Date(connection.serverTime).getTime() - Date.now());
    checks.push(check('connect', 'PASS', `serverTime=${connection.serverTime}`));
    checks.push(serverTimeSkewMs <= MAX_ALLOWED_CLOCK_SKEW_MS ? check('clock-skew', 'PASS', `${serverTimeSkewMs}ms`) : check('clock-skew', 'FAIL', `${serverTimeSkewMs}ms (signed requests may be rejected)`));
  } catch (error) {
    checks.push(check('connect', 'FAIL', error instanceof Error ? error.message.slice(0, 200) : String(error)));
    return { passed: false, checks };
  }

  try {
    const balances = await adapter.getBalance();
    const invalid = balances.filter((balance) => Number(balance.total) < 0 || Number(balance.free) < 0);
    checks.push(invalid.length > 0 ? check('balance', 'FAIL', 'negative balance values returned') : check('balance', 'PASS', `${balances.length} non-zero assets`));
  } catch (error) {
    checks.push(check('balance', 'FAIL', error instanceof Error ? error.message.slice(0, 200) : String(error)));
  }

  try {
    const positions = await adapter.getPositions();
    checks.push(positions.length === 0 ? check('positions', 'SKIP', 'no open positions or spot (no positions concept)') : check('positions', 'PASS', `${positions.length} open positions`));
  } catch (error) {
    checks.push(check('positions', 'FAIL', error instanceof Error ? error.message.slice(0, 200) : String(error)));
  }

  try {
    const orders = await adapter.getOrders();
    checks.push(check('open-orders', 'PASS', `${orders.length} open orders`));
  } catch (error) {
    checks.push(check('open-orders', 'FAIL', error instanceof Error ? error.message.slice(0, 200) : String(error)));
  }

  const passed = checks.every((item) => item.status === 'PASS' || item.status === 'SKIP');
  return { passed, ...(serverTimeSkewMs === undefined ? {} : { serverTimeSkewMs }), checks };
}