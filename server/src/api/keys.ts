import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExecutionManager } from '../engine/ExecutionManager.js';
import { ApiKeyError, toPublic, type ApiKeys } from '../users/ApiKeys.js';

/**
 * API key management. Only a signed-in browser session can create, list or
 * revoke keys; a request carrying an API key is refused, so a leaked key can't
 * mint more keys or raise its own limits.
 */
export function registerKeys(app: FastifyInstance, apiKeys: ApiKeys, manager: ExecutionManager, sessionOwner: (req: FastifyRequest) => string | null): void {
  const owner = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (req.headers.authorization) {
      void reply.code(403).send({ error: 'Manage API keys from the Argus app while signed in, not with an API key' });
      return null;
    }
    const o = sessionOwner(req);
    if (!o) void reply.code(401).send({ error: 'Connect your wallet first' });
    return o;
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ApiKeyError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get('/api/keys', async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return reply;
    return { keys: apiKeys.list(o) };
  });

  app.post('/api/keys', async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return reply;
    try {
      const b = (req.body ?? {}) as { name?: unknown; maxOrderUsd?: unknown; dailyUsd?: unknown };
      const { key, apiKey } = await apiKeys.create(o, b);
      // The only time the full key is ever shown.
      return reply.code(201).send({ key, apiKey });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/keys/:id', async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return reply;
    const k = await apiKeys.revoke(o, req.params.id);
    if (!k) return reply.code(404).send({ error: 'API key not found' });
    const stopped = await manager.cancelByApiKey(k.id);
    return { apiKey: toPublic(k), stoppedExecutions: stopped };
  });
}
