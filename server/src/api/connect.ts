import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { Accounts, ConnectError } from '../users/Accounts.js';
import { sessionCookie, sessionTtlSec } from '../users/Sessions.js';

export function sessionOwner(accounts: Accounts, env: 'mainnet' | 'testnet') {
  const name = sessionCookie(env);
  return (req: FastifyRequest): string | null => accounts.sessions.get(req.cookies?.[name])?.address ?? null;
}

export function registerConnect(app: FastifyInstance, config: Config, accounts: Accounts): void {
  const SESSION_COOKIE = sessionCookie(config.env);
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ConnectError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.post('/api/connect/start', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as { address?: unknown; chain?: unknown };
      return await accounts.start(b.address, b.chain);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/connect/finish', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as { address?: unknown; nonce?: unknown; signature?: unknown };
      const r = await accounts.finish(b.address, b.nonce, b.signature);
      reply.setCookie(SESSION_COOKIE, r.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        path: '/',
        maxAge: sessionTtlSec,
      });
      return { address: r.address, accountId: r.accountId };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/connect/logout', async (req, reply) => {
    accounts.sessions.destroy(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const s = accounts.sessions.get(req.cookies?.[SESSION_COOKIE]);
    if (!s) return reply.code(401).send({ error: 'Not connected', liveConfigured: config.liveConfigured });
    const summary = await accounts.summary(s.address);
    if (!summary) return reply.code(401).send({ error: 'Not connected', liveConfigured: config.liveConfigured });
    return summary;
  });
}
