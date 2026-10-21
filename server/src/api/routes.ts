import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Decimal } from 'decimal.js';
import type { Config } from '../config.js';
import type { MarketFeeds } from '../strike/feeds.js';
import { ExecutionManager, UserError } from '../engine/ExecutionManager.js';
import type { ExecutionParams } from '../engine/Execution.js';
import type { Store } from '../store/Store.js';
import { computeStats } from '../store/stats.js';
import { PATIENCE, type Preset } from '../engine/Strategy.js';

export interface RouteDeps {
  config: Config;
  feeds: MarketFeeds;
  manager: ExecutionManager;
  store: Store;
  /** Resolves the signed-in wallet address for a request, if any. */
  ownerOf: (req: FastifyRequest) => string | null;
}

export function parseExecutionBody(body: unknown): ExecutionParams {
  const b = (body ?? {}) as Record<string, unknown>;
  const mode = b.mode ?? 'paper';
  if (mode !== 'paper' && mode !== 'live') throw new UserError('mode must be "paper" or "live"');
  if (b.side !== 'buy' && b.side !== 'sell') throw new UserError('side must be "buy" or "sell"');
  if (typeof b.size !== 'string' && typeof b.size !== 'number') throw new UserError('size is required');
  let size: Decimal;
  try {
    size = new Decimal(String(b.size));
  } catch {
    throw new UserError('size must be a number');
  }
  if (!size.isFinite() || size.lte(0)) throw new UserError('size must be greater than 0');
  const deadlineSec = Number(b.deadlineSec ?? 300);
  if (!Number.isInteger(deadlineSec) || deadlineSec < 10 || deadlineSec > 3600) throw new UserError('deadlineSec must be a whole number from 10 to 3600');
  const maxSlippageBps = Number(b.maxSlippageBps ?? 10);
  if (!Number.isFinite(maxSlippageBps) || maxSlippageBps < 1 || maxSlippageBps > 500) throw new UserError('maxSlippageBps must be from 1 to 500');
  const preset = (b.preset ?? 'balanced') as Preset;
  if (typeof preset !== 'string' || !Object.hasOwn(PATIENCE, preset)) throw new UserError('preset must be patient, balanced or fast');
  const fallback = b.fallback ?? 'market';
  if (fallback !== 'market' && fallback !== 'cancel') throw new UserError('fallback must be "market" or "cancel"');
  return { mode, side: b.side, size, deadlineSec, maxSlippageBps, preset, fallback };
}

/** Live executions are private to their owner; paper ones are public. */
export function canSee(exec: { mode: string; owner: string | null }, viewer: string | null): boolean {
  return exec.mode === 'paper' || (viewer !== null && exec.owner === viewer);
}

export function registerRoutes(app: FastifyInstance, d: RouteDeps): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong on our side' });
  });

  app.post('/api/executions', async (req, reply) => {
    const params = parseExecutionBody(req.body);
    const exec = await d.manager.create(params, d.ownerOf(req));
    return reply.code(201).send(exec.toJSON());
  });

  app.get('/api/executions', async (req) => {
    const viewer = d.ownerOf(req);
    const running = d.manager
      .running()
      .filter((e) => canSee({ mode: e.params.mode, owner: e.owner }, viewer))
      .map((e) => e.toJSON());
    const recent = d.store
      .all()
      .filter((e) => canSee(e, viewer))
      .slice(-20)
      .reverse()
      .map(({ id, mode, side, size, state, createdAt, endedAt, report }) => {
        const r = report as { savings?: string | null; filledSize?: string } | null | undefined;
        return { id, mode, side, size, state, createdAt, endedAt, savings: r?.savings ?? null, filled: r?.filledSize ?? null };
      });
    return { running, recent };
  });

  app.get<{ Params: { id: string } }>('/api/executions/:id', async (req, reply) => {
    const { exec, stored } = d.manager.get(req.params.id);
    const viewer = d.ownerOf(req);
    if (exec && canSee({ mode: exec.params.mode, owner: exec.owner }, viewer)) return exec.toJSON();
    if (stored && canSee(stored, viewer)) {
      const { owner: _owner, ...pub } = stored;
      return pub;
    }
    return reply.code(404).send({ error: 'Execution not found' });
  });

  app.post<{ Params: { id: string } }>('/api/executions/:id/cancel', async (req, reply) => {
    const { exec } = d.manager.get(req.params.id);
    if (!exec) return reply.code(404).send({ error: 'Execution not found or already finished' });
    const viewer = d.ownerOf(req);
    // Anyone may stop a paper run (they're public demos); live only by its owner.
    if (exec.params.mode === 'live' && exec.owner !== viewer) return reply.code(404).send({ error: 'Execution not found' });
    await exec.cancel();
    return exec.toJSON();
  });

  app.get<{ Params: { id: string } }>('/api/reports/:id', async (req, reply) => {
    const { exec, stored } = d.manager.get(req.params.id);
    const viewer = d.ownerOf(req);
    const src = exec
      ? { mode: exec.params.mode, owner: exec.owner, json: exec.toJSON() as unknown as Record<string, unknown> }
      : stored
        ? { mode: stored.mode, owner: stored.owner, json: stored as Record<string, unknown> }
        : null;
    if (!src || !canSee(src, viewer)) return reply.code(404).send({ error: 'Report not found' });
    if (!src.json.report) return reply.code(409).send({ error: 'Execution is still running' });
    const j = src.json;
    return {
      id: j.id,
      mode: j.mode,
      side: j.side,
      size: j.size,
      state: j.state,
      createdAt: j.createdAt,
      endedAt: j.endedAt,
      deadlineSec: j.deadlineSec,
      maxSlippageBps: j.maxSlippageBps,
      preset: j.preset,
      fallback: j.fallback,
      arrivalMid: j.arrivalMid,
      limitPrice: j.limitPrice,
      error: j.error,
      argusFeeBps: d.config.argusFeeBps,
      takerFee: d.config.takerFee,
      makerFee: d.config.makerFee,
      report: j.report,
      fills: j.fills,
      events: j.events,
    };
  });

  app.get('/api/stats', async () => computeStats(d.store.all()));
}
