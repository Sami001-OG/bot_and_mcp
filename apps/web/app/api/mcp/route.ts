import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CommandError } from '@platform/commands';
import { constantTimeEqual } from '@platform/security';
import { McpToolError } from './mcp-error';
import { runTool, toolSpecs } from './tools';

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

class RequestTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private outgoing: JSONRPCMessage[] = [];

  async start(): Promise<void> {
    /* stateless per-request transport — nothing to start */
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.outgoing.push(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  drain(): JSONRPCMessage[] {
    const messages = this.outgoing;
    this.outgoing = [];
    return messages;
  }
}

function parseError(message: string, id: unknown = null): { jsonrpc: string; error: { code: number; message: string }; id: unknown } {
  return { jsonrpc: '2.0', error: { code: -32700, message }, id };
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).method === 'string';
}

async function settle(transport: RequestTransport, expected: number, timeoutMs: number): Promise<JSONRPCMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let responses: JSONRPCMessage[] = [];
  while (Date.now() < deadline) {
    responses = responses.concat(transport.drain());
    if (responses.length >= expected) return responses;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return responses;
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
  const sessionId = request.headers.get('mcp-session-id') ?? randomUUID();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(parseError('Parse error: request body is not valid JSON'), { status: 400 });
  }
  const messages = Array.isArray(body) ? body : [body];
  const expected = messages.filter(isMessage).filter((message) => message.id !== undefined).length;
  const transport = new RequestTransport();
  const server = await createServer();
  try {
    await server.connect(transport as Parameters<McpServer['connect']>[0]);
    for (const message of messages) {
      if (isMessage(message)) transport.onmessage?.(message as JSONRPCMessage);
    }
    const responses = expected > 0 ? await settle(transport, expected, 60_000) : transport.drain();
    if (responses.length === 0) {
      return new NextResponse(null, { status: 202, headers: { 'mcp-session-id': sessionId } });
    }
    const payload = responses.length === 1 ? (responses[0] as unknown) : responses;
    return NextResponse.json(payload, { status: 200, headers: { 'mcp-session-id': sessionId } });
  } catch (error) {
    return NextResponse.json(parseError(error instanceof Error ? error.message : String(error)), { status: 500 });
  } finally {
    await server.close().catch(() => undefined);
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accept = request.headers.get('accept') ?? '';
  if (!accept.includes('text/event-stream')) {
    return NextResponse.json({ error: 'Use POST for JSON-RPC. This endpoint only supports SSE connections for server-initiated messages.' }, { status: 405 });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`: connected\n\n`));
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15_000);
      const closeTimer = setTimeout(() => {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, 55_000);
      request.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        clearTimeout(closeTimer);
      });
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'mcp-session-id': request.headers.get('mcp-session-id') ?? randomUUID(),
    },
  });
}

export async function DELETE(): Promise<Response> {
  if (!process.env.MCP_PASSWORD && !process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(null, { status: 200 });
}