import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { Decimal } from 'decimal.js';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Exchange } from '../exchange/Exchange.js';
import type { Store, StoredExecution } from '../store/Store.js';
import type { ApiKeyRecord } from '../users/ApiKeys.js';
import { Execution, type ExecutionParams, type RecordedFill } from './Execution.js';
import { PaperVenue } from './PaperVenue.js';
import type { Venue } from './Venue.js';

interface ManagerEvents {
  change: [Execution];
  fill: [Execution, RecordedFill];
  done: [Execution];
}

const KEEP_FINISHED_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export interface CreateOptions {
  /** The API key the request was authenticated with, if any; its limits apply to live orders. */
  apiKey?: ApiKeyRecord;
  /** The caller's own reference for this order, returned on every view and receipt. */
  clientRef?: string;
}

export interface ExecutionMeta {
  apiKeyId?: string;
  clientRef?: string;
}

export class ExecutionManager extends EventEmitter<ManagerEvents> {
  private active = new Map<string, Execution>();
  private paperVenues = new Map<string, PaperVenue>();
  private meta = new Map<string, ExecutionMeta>();

  constructor(
    private readonly config: Config,
    private readonly exchange: Exchange,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
    exchange.market.on('update', (u, res) => {
      for (const v of this.paperVenues.values()) v.onUpdate(u, res);
    });
    exchange.market.on('synced', () => {
      for (const v of this.paperVenues.values()) v.onResync();
    });
  }

  async create(params: ExecutionParams, owner: string | null, opts: CreateOptions = {}): Promise<Execution> {
    const market = this.exchange.market;
    const rules = market.rules;
    if (!rules) throw new UserError('Market rules are still loading, try again in a moment');
    if (!market.isLive) throw new UserError('The order book is resyncing, try again in a moment');
    const id = uuidv4().slice(0, 8);

    let venue: Venue;
    if (params.mode === 'live') {
      if (!this.config.liveConfigured) throw new UserError(this.config.liveNotConfiguredReason!);
      if (!owner) throw new UserError('Connect your wallet to trade live', 401);
      if ([...this.active.values()].some((e) => e.owner === owner && e.params.mode === 'live' && !e.isFinished)) {
        throw new UserError('You already have a live execution running. Stop it first.');
      }
      if (opts.apiKey) this.checkLimits(opts.apiKey, params);
      try {
        venue = await this.exchange.createLiveVenue(owner, id);
      } catch (err) {
        if (err instanceof UserError) throw err;
        const status = (err as { status?: number }).status;
        throw new UserError((err as Error).message, status && status < 500 ? status : 400);
      }
    } else {
      const pv = new PaperVenue(market.book, { makerFee: this.config.makerFee, takerFee: this.config.takerFee });
      this.paperVenues.set(id, pv);
      venue = pv;
    }

    const exec = new Execution({
      id,
      owner,
      params,
      venue,
      book: market.book,
      model: market.model,
      rules,
      argusFeeBps: this.config.argusFeeBps,
      takerFee: new Decimal(this.config.takerFee),
      logger: this.logger.child({ exec: id }),
      minActionGapMs: 500,
      bookLive: () => market.isLive,
    });
    exec.on('change', (e) => this.emit('change', e));
    exec.on('fill', (e, f) => this.emit('fill', e, f));
    exec.on('done', (e) => this.onDone(e));
    try {
      exec.start();
    } catch (err) {
      this.paperVenues.delete(id);
      venue.close();
      throw new UserError((err as Error).message);
    }
    this.active.set(id, exec);
    const meta: ExecutionMeta = {};
    if (opts.apiKey) meta.apiKeyId = opts.apiKey.id;
    if (opts.clientRef) meta.clientRef = opts.clientRef;
    this.meta.set(id, meta);
    this.logger.info({ exec: id, mode: params.mode, side: params.side, size: params.size.toString(), apiKey: opts.apiKey?.id }, 'execution started');
    return exec;
  }

  /** Per-order and per-day USD limits for executions started with an API key. */
  private checkLimits(key: ApiKeyRecord, params: ExecutionParams): void {
    const mid = this.exchange.market.book.mid();
    if (!mid) throw new UserError('No market price yet, try again in a moment');
    const notional = params.size.mul(mid).toNumber();
    if (notional > key.limits.maxOrderUsd) {
      throw new UserError(`This order is about ${usd(notional)}, over this API key's per-order limit of ${usd(key.limits.maxOrderUsd)}`, 403);
    }
    const used = this.usageToday(key.id);
    if (used + notional > key.limits.dailyUsd) {
      throw new UserError(`This order would take today's usage to about ${usd(used + notional)}, over this API key's daily limit of ${usd(key.limits.dailyUsd)}`, 403);
    }
  }

  /** Live notional started with this key since 00:00 UTC, at each execution's arrival mid. */
  usageToday(apiKeyId: string): number {
    const since = Math.floor(this.now() / DAY_MS) * DAY_MS;
    let total = 0;
    const add = (mode: string, createdAt: number, size: unknown, mid: unknown) => {
      if (mode !== 'live' || createdAt < since) return;
      const n = Number(size) * Number(mid);
      if (Number.isFinite(n)) total += n;
    };
    for (const e of this.active.values()) {
      if (this.meta.get(e.id)?.apiKeyId !== apiKeyId) continue;
      const j = e.toJSON() as unknown as { mode: string; createdAt: number; size: string; arrivalMid: string | null };
      add(j.mode, j.createdAt, j.size, j.arrivalMid);
    }
    for (const r of this.store.all()) {
      if (r.apiKeyId !== apiKeyId || this.active.has(r.id)) continue;
      add(r.mode, r.createdAt, r.size, r.arrivalMid);
    }
    return total;
  }

  /** Stops every running execution started with this key (used when the key is revoked). */
  async cancelByApiKey(apiKeyId: string): Promise<number> {
    const running = this.running().filter((e) => this.meta.get(e.id)?.apiKeyId === apiKeyId);
    await Promise.all(running.map((e) => e.cancel('API key revoked')));
    return running.length;
  }

  private onDone(e: Execution): void {
    this.paperVenues.delete(e.id);
    void this.store
      .save({ ...(e.toJSON() as unknown as StoredExecution), owner: e.owner, ...this.meta.get(e.id) })
      .catch((err: Error) => this.logger.error({ err: err.message, exec: e.id }, 'failed to save execution'));
    this.emit('done', e);
    setTimeout(() => {
      this.active.delete(e.id);
      this.meta.delete(e.id);
    }, KEEP_FINISHED_MS).unref();
  }

  get(id: string): { exec?: Execution; stored?: StoredExecution } {
    const exec = this.active.get(id);
    if (exec) return { exec };
    const stored = this.store.get(id);
    return stored ? { stored } : {};
  }

  /** API key and client reference for a running or stored execution. */
  metaOf(id: string): ExecutionMeta {
    const m = this.meta.get(id);
    if (m) return m;
    const r = this.store.get(id);
    return r ? { apiKeyId: r.apiKeyId, clientRef: typeof r.clientRef === 'string' ? r.clientRef : undefined } : {};
  }

  /** One owner's executions, newest first: running ones (live state) and stored ones. */
  listFor(owner: string, limit = 50): { exec?: Execution; stored?: StoredExecution; createdAt: number }[] {
    const out: { exec?: Execution; stored?: StoredExecution; createdAt: number }[] = [];
    for (const e of this.active.values()) if (e.owner === owner) out.push({ exec: e, createdAt: e.createdAt });
    for (const r of this.store.all()) if (r.owner === owner && !this.active.has(r.id)) out.push({ stored: r, createdAt: r.createdAt });
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  running(): Execution[] {
    return [...this.active.values()].filter((e) => !e.isFinished);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.running().map((e) => e.cancel('Server shutting down')));
  }
}

export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
