import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ArgusClient } from '../mcp/client.js';
import { createArgusMcpServer } from '../mcp/tools.js';
import { AuthError, type Caller } from './auth.js';

/** A fetch that answers from this same app in-process, so MCP tools see exactly what the public API returns. */
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const res = await app.inject({
      method: (init.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers: init.headers as Record<string, string>,
      payload: typeof init.body === 'string' ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') } });
  }) as typeof fetch;
}

/**
 * Remote MCP at /mcp (Streamable HTTP, stateless). Agent hosts connect with the URL
 * and "Authorization: Bearer <API key>"; every tool call runs as that key.
 */
export function registerMcpHttp(app: FastifyInstance, callerOf: (req: FastifyRequest) => Caller | null, opts: { pollMs?: number } = {}): void {
  const fetchFn = injectFetch(app);
  const unauthorized = (message: string) => ({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

  app.post('/mcp', async (req, reply) => {
    let caller: Caller | null;
    try {
      caller = callerOf(req);
    } catch (err) {
      return reply.code(401).header('www-authenticate', 'Bearer').send(unauthorized((err as AuthError).message));
    }
    if (!caller || caller.via !== 'apiKey') {
      return reply.code(401).header('www-authenticate', 'Bearer').send(unauthorized('Send an Argus API key as "Authorization: Bearer argus_…"'));
    }
    const token = String(req.headers.authorization).replace(/^Bearer\s+/i, '');
    const server = createArgusMcpServer(new ArgusClient('http://argus.internal', token, fetchFn), opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless server: no server-initiated stream and no sessions to end.
  const notAllowed = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null };
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send(notAllowed));
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send(notAllowed));
}
