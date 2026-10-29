import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebhookError, type Webhooks } from '../webhooks/Webhooks.js';

/** Webhook management. Like API keys, only a signed-in browser session can manage them. */
export function registerWebhooks(app: FastifyInstance, webhooks: Webhooks, sessionOwner: (req: FastifyRequest) => string | null): void {
  const owner = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (req.headers.authorization) {
      void reply.code(403).send({ error: 'Manage webhooks from the Argus app while signed in, not with an API key' });
      return null;
    }
    const o = sessionOwner(req);
    if (!o) void reply.code(401).send({ error: 'Connect your wallet first' });
    return o;
  };

  app.get('/api/webhooks', async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return reply;
    return { webhooks: webhooks.list(o) };
  });

  app.post('/api/webhooks', async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return reply;
    try {
      const { secret, webhook } = await webhooks.create(o, (req.body as { url?: unknown } | undefined)?.url);
      // The only time the signing secret is shown.
      return reply.code(201).send({ secret, webhook });
    } catch (err) {
      if (err instanceof WebhookError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/webhooks/:id', async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return reply;
    if (!(await webhooks.remove(o, req.params.id))) return reply.code(404).send({ error: 'Webhook not found' });
    return { deleted: true };
  });
}
