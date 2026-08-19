import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CommandError } from '@platform/commands';
import { prisma } from '@platform/database';
import { constantTimeEqual } from '@platform/security';
import { McpToolError } from '../../mcp-error';
import { botToolSpecs, runBotTool } from '../../tools';
import { handleMcpGet, handleMcpPost } from '../../server';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function authorizeBot(request: NextRequest, botId: string): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, include: { webhook: { select: { signingSecret: true } } } });
  if (!bot) {
    return { ok: false, status: 404, body: { jsonrpc: '2.0', error: { code: -32004, message: 'Bot not found' }, id: null } };
  }
  if (!bot.webhook) {
    return { ok: false, status: 409, body: { jsonrpc: '2.0', error: { code: -32004, message: 'Bot has no webhook endpoint' }, id: null } };
  }
  const header = request.headers.get('authorization') ?? '';
  const password = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : (request.headers.get('x-mcp-password') ?? '');
  if (!password || !constantTimeEqual(password, bot.webhook.signingSecret)) {
    return { ok: false, status: 401, body: { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: provide the bot password via Authorization: Bearer <password>' }, id: null } };
  }
  return { ok: true };
}

async function createBotServer(botId: string): Promise<McpServer> {
  const server = new McpServer({ name: 'crypto-trading-platform', version: '1.0.0' });
  for (const spec of botToolSpecs(botId)) {
    server.tool(spec.name, spec.description, spec.schema, async (args) => {
      const correlationId = randomUUID();
      try {
        const result = await runBotTool(spec.name, (args ?? {}) as Record<string, unknown>, botId);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: spec.name, correlationId, botId, ...result }) }] };
      } catch (error) {
        const err = error instanceof McpToolError
          ? error
          : error instanceof CommandError
            ? new McpToolError(error.code, error.message.slice(0, 300), error.statusCode)
            : new McpToolError('INTERNAL_ERROR', error instanceof Error ? error.message.slice(0, 300) : String(error), 500);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: spec.name, correlationId, botId, error: err.message, code: err.code, status: err.status }) }] };
      }
    });
  }
  return server;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ botId: string }> }): Promise<NextResponse> {
  const { botId } = await params;
  const auth = await authorizeBot(request, botId);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  return handleMcpPost(request, await createBotServer(botId));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ botId: string }> }): Promise<Response> {
  const { botId } = await params;
  const auth = await authorizeBot(request, botId);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  return handleMcpGet(request);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ botId: string }> }): Promise<Response> {
  const { botId } = await params;
  const auth = await authorizeBot(request, botId);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  return NextResponse.json(null, { status: 200 });
}