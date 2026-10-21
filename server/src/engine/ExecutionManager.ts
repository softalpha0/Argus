import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { Decimal } from 'decimal.js';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { MarketFeeds } from '../strike/feeds.js';
import type { Store, StoredExecution } from '../store/Store.js';
import { Execution, type ExecutionParams, type RecordedFill } from './Execution.js';
import { PaperVenue } from './PaperVenue.js';
import type { Venue } from './Venue.js';

export interface LiveVenueFactory {
  /** Creates a venue for a signed-in user, or throws with a user-facing message. */
  create(owner: string, executionId: string): Promise<Venue>;
}

interface ManagerEvents {
  change: [Execution];
  fill: [Execution, RecordedFill];
  done: [Execution];
}

const KEEP_FINISHED_MS = 10 * 60_000;

export class ExecutionManager extends EventEmitter<ManagerEvents> {
  private active = new Map<string, Execution>();
  private paperVenues = new Map<string, PaperVenue>();
  liveFactory: LiveVenueFactory | null = null;

  constructor(
    private readonly config: Config,
    private readonly feeds: MarketFeeds,
    private readonly store: Store,
    private readonly logger: Logger,
  ) {
    super();
    feeds.l3.on('update', (u, res) => {
      for (const v of this.paperVenues.values()) v.onUpdate(u, res);
    });
    feeds.l3.on('synced', () => {
      for (const v of this.paperVenues.values()) v.onResync();
    });
  }

  async create(params: ExecutionParams, owner: string | null): Promise<Execution> {
    const rules = this.feeds.rules;
    if (!rules) throw new UserError('Market rules are still loading, try again in a moment');
    if (!this.feeds.l3.isLive) throw new UserError('The order book is resyncing, try again in a moment');
    const id = uuidv4().slice(0, 8);

    let venue: Venue;
    if (params.mode === 'live') {
      if (!this.config.liveConfigured) throw new UserError(this.config.liveNotConfiguredReason!);
      if (!owner) throw new UserError('Connect your wallet to trade live', 401);
      if (!this.liveFactory) throw new UserError('Live trading is not available yet');
      if ([...this.active.values()].some((e) => e.owner === owner && e.params.mode === 'live' && !e.isFinished)) {
        throw new UserError('You already have a live execution running. Stop it first.');
      }
      venue = await this.liveFactory.create(owner, id);
    } else {
      const pv = new PaperVenue(this.feeds.l3.book, { makerFee: this.config.makerFee, takerFee: this.config.takerFee });
      this.paperVenues.set(id, pv);
      venue = pv;
    }

    const exec = new Execution({
      id,
      owner,
      params,
      venue,
      book: this.feeds.l3.book,
      model: this.feeds.model,
      rules,
      argusFeeBps: this.config.argusFeeBps,
      takerFee: new Decimal(this.config.takerFee),
      logger: this.logger.child({ exec: id }),
      minActionGapMs: 500,
      bookLive: () => this.feeds.l3.isLive,
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
    this.logger.info({ exec: id, mode: params.mode, side: params.side, size: params.size.toString() }, 'execution started');
    return exec;
  }

  private onDone(e: Execution): void {
    this.paperVenues.delete(e.id);
    try {
      this.store.save({ ...(e.toJSON() as unknown as StoredExecution), owner: e.owner });
    } catch (err) {
      this.logger.error({ err: (err as Error).message, exec: e.id }, 'failed to save execution');
    }
    this.emit('done', e);
    setTimeout(() => this.active.delete(e.id), KEEP_FINISHED_MS).unref();
  }

  get(id: string): { exec?: Execution; stored?: StoredExecution } {
    const exec = this.active.get(id);
    if (exec) return { exec };
    const stored = this.store.get(id);
    return stored ? { stored } : {};
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
