import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CommandError } from '@platform/commands';
import { constantTimeEqual } from '@platform/security';
import { McpToolError } from './mcp-error';
import { runTool, toolSpecs } from './tools';
import { handleMcpGet, handleMcpPost } from './server';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const PASSWORD = process.env.MCP_PASSWORD || process.env.APP_PASSWORD || '';

function authorized(request: NextRequest): boolean {
  if (!PASSWORD) return false;
  const header = request.headers.get('authorization') ?? '';
  const password = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : (request.headers.get('x-mcp-password') ?? '');
  return constantTimeEqual(password, PASSWORD);
}

async function createServer(): Promise<McpServer> {
  const server = new McpServer({ name: 'crypto-trading-platform', version: '1.0.0' });
  for (const spec of toolSpecs) {
    server.tool(spec.name, spec.description, spec.schema, async (args) => {
      const correlationId = randomUUID();
      try {
        const result = await runTool(spec.name, (args ?? {}) as Record<string, unknown>);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: spec.name, correlationId, ...result }) }] };
      } catch (error) {
        const err = error instanceof McpToolError
          ? error
          : error instanceof CommandError
            ? new McpToolError(error.code, error.message.slice(0, 300), error.statusCode)
            : new McpToolError('INTERNAL_ERROR', error instanceof Error ? error.message.slice(0, 300) : String(error), 500);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: spec.name, correlationId, error: err.message, code: err.code, status: err.status }) }] };
      }
    });
  }
  return server;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: provide the MCP password via Authorization: Bearer <password>' }, id: null }, { status: 401 });
  }
  return handleMcpPost(request, await createServer());
}

export async function GET(request: NextRequest): Promise<Response> {
  if (request.nextUrl.searchParams.get('warm') === '1') {
    return NextResponse.json({ ok: true, ts: new Date().toISOString() });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return handleMcpGet(request);
}

export async function DELETE(): Promise<Response> {
  if (!process.env.MCP_PASSWORD && !process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(null, { status: 200 });
}