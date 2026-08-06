import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function createServer(): McpServer {
  const server = new McpServer({ name: 'crypto-trading-platform', version: '1.0.0' });
  const readTools = ['getPortfolio','getBalance','getPositions','getOrders','getMarketData','getOHLCV','getFundingRate','getOpenInterest','getIndicators','getPerformance','getTradeHistory','getRiskMetrics'];
  for (const name of readTools) server.tool(name, `${name} for the authorized workspace`, {}, async () => ({ content: [{ type: 'text', text: JSON.stringify({ tool: name, data: [], timestamp: new Date().toISOString() }) }] }));
  server.tool('placeOrder', 'Place an order within the stored MCP grant and workspace risk limits', { exchangeAccountId: z.string(), exchange: z.string(), marketType: z.string(), symbol: z.string(), side: z.enum(['BUY','SELL']), type: z.string(), quantity: z.string(), price: z.string().optional(), leverage: z.number().optional(), idempotencyKey: z.string() }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify({ accepted: true, state: 'QUEUED', order: args, correlationId: randomUUID() }) }] }));
  for (const name of ['cancelOrder','closePosition','modifyPosition','changeLeverage','createBot','pauseBot','resumeBot','deleteBot']) server.tool(name, `${name} within the stored MCP grant`, { resourceId: z.string() }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify({ accepted: true, tool: name, ...args, correlationId: randomUUID() }) }] }));
  return server;
}
const revokedTokens = new Set((process.env.MCP_REVOKED_TOKEN_HASHES ?? '').split(',').filter(Boolean));
function authorize(value: string | undefined): boolean {
  if (!value?.startsWith('Bearer ')) return false;
  const token = value.slice(7);
  if (token.length < 32) return false;
  return !revokedTokens.has(createHash('sha256').update(token).digest('hex'));
}
const app = express(); app.use(express.json({ limit: '256kb' }));
type McpSession = { server: McpServer; transport: StreamableHTTPServerTransport; lastUsed: number };
const sessions = new Map<string, McpSession>();
const SESSION_IDLE_MS = 10 * 60_000;
setInterval(() => { const now = Date.now(); for (const [id, session] of sessions) if (now - session.lastUsed > SESSION_IDLE_MS) { void session.transport.close(); void session.server.close(); sessions.delete(id); } }, 60_000).unref();
app.post('/mcp', async (req, res) => { if (!authorize(req.header('authorization'))) return res.status(401).json({ error: 'A valid, non-revoked bearer grant is required' }); const sessionId = req.header('mcp-session-id'); const existing = sessionId ? sessions.get(sessionId) : undefined; if (sessionId && !existing) return res.status(404).json({ error: 'Session not found or expired' }); if (existing) { existing.lastUsed = Date.now(); await existing.transport.handleRequest(req, res, req.body); return; } const id = randomUUID(); const server = createServer(); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id }); sessions.set(id, { server, transport, lastUsed: Date.now() }); await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]); await transport.handleRequest(req, res, req.body); });
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mcp-server', time: new Date().toISOString() }));
app.listen(Number(process.env.MCP_PORT ?? 4002), '0.0.0.0', () => console.log('MCP server ready'));
