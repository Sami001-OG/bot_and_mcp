import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Redis } from 'ioredis';
import { prisma, type McpClient } from '@platform/database';
import { OrdersQueue } from '@platform/commands';
import { McpToolError, tokenHashOf } from './grant.js';
import { CommandError } from '@platform/commands';
import { runTool, toolSpecs, type ToolContext, type ToolDeps } from './tools.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const ordersQueue = OrdersQueue.connect(redis);

const deps: ToolDeps = {
  enqueueExecute: (orderId) => ordersQueue.enqueueExecute(orderId),
  enqueueCancel: (orderId) => ordersQueue.enqueueCancel(orderId),
  enqueueCloseAll: (exchangeAccountId) => ordersQueue.enqueueCloseAll(exchangeAccountId),
};

const revokedTokens = new Set((process.env.MCP_REVOKED_TOKEN_HASHES ?? '').split(',').filter(Boolean));

async function authorize(value: string | undefined): Promise<McpClient | null> {
  if (!value?.startsWith('Bearer ')) return null;
  const token = value.slice(7);
  if (token.length < 32) return null;
  const tokenHash = tokenHashOf(token);
  if (revokedTokens.has(tokenHash)) return null;
  const client = await prisma.mcpClient.findUnique({ where: { tokenHash } });
  if (!client) return null;
  if (client.revokedAt !== null) return null;
  if (client.expiresAt <= new Date()) return null;
  return client;
}

function createServer(client: McpClient): McpServer {
  const server = new McpServer({ name: 'crypto-trading-platform', version: '1.0.0' });
  for (const spec of toolSpecs) {
    server.tool(spec.name, spec.description, spec.schema, async (args) => {
      const correlationId = randomUUID();
      const startedAt = Date.now();
      let decision: 'ALLOWED' | 'DENIED' | 'ERROR' = 'ALLOWED';
      let code = 'ok';
      const ctx: ToolContext = { client, workspaceId: client.workspaceId, correlationId };
      try {
        const result = await runTool(spec.name, ctx, args as Record<string, unknown>, deps);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: spec.name, correlationId, ...result }) }] };
      } catch (error) {
        const err = error instanceof McpToolError
          ? error
          : error instanceof CommandError
            ? new McpToolError(error.code, error.message.slice(0, 300), error.statusCode)
            : new McpToolError('INTERNAL_ERROR', error instanceof Error ? error.message.slice(0, 300) : String(error), 500);
        code = err.code;
        decision = err.status >= 500 ? 'ERROR' : 'DENIED';
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: spec.name, correlationId, error: err.message, code: err.code, status: err.status }) }] };
      } finally {
        void prisma.mcpInvocation
          .create({
            data: {
              clientId: client.id,
              tool: spec.name,
              argumentsHash: tokenHashOf(JSON.stringify(args ?? {})),
              decision,
              resultCode: code,
              latencyMs: Date.now() - startedAt,
              correlationId,
            },
          })
          .catch(() => undefined);
      }
    });
  }
  return server;
}

const app = express();
app.use(express.json({ limit: '256kb' }));

type McpSession = { server: McpServer; transport: StreamableHTTPServerTransport; clientId: string; lastUsed: number };
const sessions = new Map<string, McpSession>();
const SESSION_IDLE_MS = 10 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_IDLE_MS) {
      void session.transport.close();
      void session.server.close();
      sessions.delete(id);
    }
  }
}, 60_000).unref();

app.post('/mcp', async (req, res) => {
  const client = await authorize(String(req.header('authorization') ?? ''));
  if (!client) return res.status(401).json({ error: 'A valid, active MCP grant bearer token is required' });
  const sessionId = req.header('mcp-session-id');
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !existing) return res.status(404).json({ error: 'Session not found or expired' });
  if (existing) {
    existing.lastUsed = Date.now();
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }
  const id = randomUUID();
  const server = createServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
  sessions.set(id, { server, transport, clientId: client.id, lastUsed: Date.now() });
  await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
  await transport.handleRequest(req, res, req.body);
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mcp-server', time: new Date().toISOString() }));

const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? 4002);
app.listen(port, '0.0.0.0', () => console.log(`MCP server ready on :${port}`));

async function shutdown(): Promise<void> {
  for (const session of sessions.values()) {
    void session.transport.close();
    void session.server.close();
  }
  sessions.clear();
  await ordersQueue.close();
  await redis.quit();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());