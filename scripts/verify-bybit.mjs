import { createExchangeAdapter } from '../packages/exchange-adapters/dist/index.js';

const apiKey = process.env.BYBIT_API_KEY;
const secret = process.env.BYBIT_SECRET_KEY;
if (!apiKey || !secret) throw new Error('BYBIT_API_KEY / BYBIT_SECRET_KEY must be set in .env');

const credentials = { apiKey, secret };
const adapter = createExchangeAdapter('bybit', 'SPOT');
const connection = await adapter.connect(credentials);
console.log(JSON.stringify({ step: 'connect', connected: connection.connected, serverTime: connection.serverTime, permissions: connection.permissions, proxy: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy) }));
const balances = await adapter.getBalance();
console.log(JSON.stringify({ step: 'balance', count: balances.length, nonZero: balances.map((b) => ({ asset: b.asset, free: b.free, locked: b.locked, total: b.total })) }));
const positions = await adapter.getPositions();
console.log(JSON.stringify({ step: 'positions', count: positions.length }));
const orders = await adapter.getOrders();
console.log(JSON.stringify({ step: 'openOrders', count: orders.length }));
await adapter.disconnect();
console.log('verify-bybit: SUCCESS');
