import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExecutionManager } from '../engine/ExecutionManager.js';
import type { Execution, RecordedFill } from '../engine/Execution.js';
import { UserError } from '../engine/ExecutionManager.js';
import { parseExecutionBody } from './routes.js';
import { AuthError, type Caller } from './auth.js';
import { buildReceipt, executionView, fillView, isFinished, type ExecutionSnapshot, type VenueInfo } from './receipt.js';
import { fingerprint, validIdempotencyKey, type Idempotency } from './idempotency.js';

export interface V1Deps {
  manager: ExecutionManager;
  venue: VenueInfo;
  callerOf: (req: FastifyRequest) => Caller | null;
  idempotency: Idempotency;
  /** Stream refresh interval; tests shorten it. */
  streamTickMs?: number;
}

/** Error types programs can branch on; the message is for people. */
export type V1ErrorType =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'limit_exceeded'
  | 'not_found'
  | 'conflict'
  | 'idempotency_key_reused'
  | 'not_ready'
  | 'unavailable'
  | 'server_error';

export class V1Error extends Error {
  constructor(readonly status: number, readonly type: V1ErrorType, message: string) {
    super(message);
  }
}

function typeFor(status: number, message: string): V1ErrorType {
  if (status === 401) return 'unauthorized';
  if (status === 403) return /limit/i.test(message) ? 'limit_exceeded' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 503) return 'unavailable';
  return status >= 500 ? 'server_error' : 'invalid_request';
}

const CLIENT_REF = /^[\x20-\x7e]{1,100}$/;
const HEARTBEAT_MS = 15_000;

/**
 * The versioned API for programs and AI agents. Every request needs an API key
 * (or a signed-in session), and callers only ever see their own executions.
 */
export function registerV1(app: FastifyInstance, d: V1Deps): void {
  void app.register(
    async (v1) => {
      v1.setErrorHandler((err, _req, reply) => {
        if (err instanceof V1Error) return reply.code(err.status).send({ error: { type: err.type, message: err.message } });
        if (err instanceof UserError || err instanceof AuthError) {
          return reply.code(err.status).send({ error: { type: typeFor(err.status, err.message), message: err.message } });
        }
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status < 500) return reply.code(status).send({ error: { type: typeFor(status, (err as Error).message), message: (err as Error).message } });
        v1.log.error({ err }, 'v1 request failed');
        return reply.code(500).send({ error: { type: 'server_error', message: 'Something went wrong on our side' } });
      });

      const caller = (req: FastifyRequest): Caller => {
        const c = d.callerOf(req);
        if (!c) throw new V1Error(401, 'unauthorized', 'Send your API key as "Authorization: Bearer argus_…"');
        return c;
      };

      /** The caller's own execution, running or stored. Someone else's reads as not found. */
      const find = (id: string, owner: string): { exec?: Execution; snapshot: ExecutionSnapshot } => {
        const { exec, stored } = d.manager.get(id);
        if (exec && exec.owner === owner) return { exec, snapshot: exec.toJSON() as unknown as ExecutionSnapshot };
        if (stored && stored.owner === owner) return { snapshot: stored as unknown as ExecutionSnapshot };
        throw new V1Error(404, 'not_found', 'Execution not found');
      };
      const view = (j: ExecutionSnapshot) => executionView(j, d.venue, d.manager.metaOf(j.id));
      const receipt = (j: ExecutionSnapshot) => buildReceipt(j, d.venue, d.manager.metaOf(j.id));

      v1.post('/executions', async (req, reply) => {
        const c = caller(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const params = parseExecutionBody(body);
        let clientRef: string | undefined;
        if (body.clientRef !== undefined && body.clientRef !== null) {
          if (typeof body.clientRef !== 'string' || !CLIENT_REF.test(body.clientRef)) throw new V1Error(400, 'invalid_request', 'clientRef must be 1 to 100 printable characters');
          clientRef = body.clientRef;
        }

        const rawKey = req.headers['idempotency-key'];
        const key = typeof rawKey === 'string' ? rawKey : undefined;
        if (key !== undefined && !validIdempotencyKey(key)) throw new V1Error(400, 'invalid_request', 'Idempotency-Key must be 1 to 200 printable characters');
        const fp = fingerprint(body);
        if (key !== undefined) {
          const b = d.idempotency.begin(c.owner, key, fp);
          if (b.kind === 'replay') {
            const { snapshot } = find(b.executionId, c.owner);
            return reply.code(200).header('idempotent-replayed', 'true').send(view(snapshot));
          }
          if (b.kind === 'mismatch') throw new V1Error(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request');
          if (b.kind === 'in_progress') throw new V1Error(409, 'conflict', 'A request with this Idempotency-Key is still being processed; retry shortly');
        }
        try {
          const exec = await d.manager.create(params, c.owner, { apiKey: c.apiKey, clientRef });
          if (key !== undefined) await d.idempotency.complete(c.owner, key, fp, exec.id);
          return reply.code(201).send(view(exec.toJSON() as unknown as ExecutionSnapshot));
        } catch (err) {
          if (key !== undefined) d.idempotency.abort(c.owner, key);
          throw err;
        }
      });

      v1.get<{ Querystring: { limit?: string } }>('/executions', async (req) => {
        const c = caller(req);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
        const data = d.manager.listFor(c.owner, limit).map((x) => view((x.exec ? x.exec.toJSON() : x.stored) as unknown as ExecutionSnapshot));
        return { object: 'list', data };
      });

      v1.get<{ Params: { id: string } }>('/executions/:id', async (req) => view(find(req.params.id, caller(req).owner).snapshot));

      v1.post<{ Params: { id: string } }>('/executions/:id/cancel', async (req) => {
        const c = caller(req);
        const { exec, snapshot } = find(req.params.id, c.owner);
        // Cancelling a finished execution is a no-op, so retries are safe.
        if (!exec || exec.isFinished) return view(snapshot);
        await exec.cancel(c.via === 'apiKey' ? 'Stopped through the API' : 'Stopped by you');
        return view(exec.toJSON() as unknown as ExecutionSnapshot);
      });

      v1.get<{ Params: { id: string } }>('/executions/:id/receipt', async (req) => {
        const { snapshot } = find(req.params.id, caller(req).owner);
        if (!isFinished(snapshot)) throw new V1Error(409, 'not_ready', 'The execution is still running; the receipt is ready when it finishes');
        return receipt(snapshot);
      });

      // Server-Sent Events: "execution" snapshots while it runs, a "fill" per fill,
      // then a final "execution" and the "receipt", after which the stream closes.
      v1.get<{ Params: { id: string } }>('/executions/:id/events', async (req, reply: FastifyReply) => {
        const c = caller(req);
        const id = req.params.id;
        const first = find(id, c.owner);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const current = (): ExecutionSnapshot => {
          const { exec, stored } = d.manager.get(id);
          return (exec ? exec.toJSON() : stored) as unknown as ExecutionSnapshot;
        };

        let closed = false;
        const finishStream = () => {
          if (closed) return;
          const j = current();
          send('execution', view(j));
          send('receipt', receipt(j));
          cleanup();
          res.end();
        };
        if (!first.exec) {
          // Already stored: send the outcome and close.
          send('execution', view(first.snapshot));
          send('receipt', receipt(first.snapshot));
          res.end();
          return;
        }
        const exec = first.exec;

        let dirty = false;
        let lastSent = Date.now();
        const onChange = (e: Execution) => {
          if (e.id === id) dirty = true;
        };
        const onFill = (e: Execution, f: RecordedFill) => {
          if (e.id === id) send('fill', fillView(f));
        };
        const onDone = (e: Execution) => {
          if (e.id === id) finishStream();
        };
        const tickMs = d.streamTickMs ?? 250;
        const tick = setInterval(() => {
          // On change, and at least once a second so the countdown and queue stay current.
          if (dirty || Date.now() - lastSent >= 1000) {
            dirty = false;
            lastSent = Date.now();
            send('execution', view(current()));
          }
        }, tickMs);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
        const cleanup = () => {
          closed = true;
          clearInterval(tick);
          clearInterval(heartbeat);
          d.manager.off('change', onChange);
          d.manager.off('fill', onFill);
          d.manager.off('done', onDone);
        };
        d.manager.on('change', onChange);
        d.manager.on('fill', onFill);
        d.manager.on('done', onDone);
        req.raw.on('close', cleanup);
        // It may have settled (checks and venue records collected) before we subscribed.
        if (exec.settled) finishStream();
        else send('execution', view(first.snapshot));
      });
    },
    { prefix: '/v1' },
  );
}
