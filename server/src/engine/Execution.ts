import { EventEmitter } from 'node:events';
import { Decimal } from 'decimal.js';
import type { Logger } from 'pino';
import type { OrderBook, Side } from '../book/OrderBook.js';
import type { MarketModel } from '../model/MarketModel.js';
import { checkOrder, type SymbolRules } from '../strike/exchangeInfo.js';
import { buildReport, type ExecutionReport } from '../report/Report.js';
import { decide, priceGuard, type Decision, type Fallback, type Preset } from './Strategy.js';
import { PostOnlyRejected, type Fill, type Venue, type WorkingOrder } from './Venue.js';

export interface ExecutionParams {
  mode: 'paper' | 'live';
  side: Side;
  size: Decimal;
  deadlineSec: number;
  maxSlippageBps: number;
  preset: Preset;
  fallback: Fallback;
}

export type ExecutionState = 'working' | 'finishing' | 'done' | 'canceled' | 'failed';

export interface ExecutionDeps {
  id: string;
  owner: string | null;
  params: ExecutionParams;
  venue: Venue;
  book: OrderBook;
  model: MarketModel;
  rules: SymbolRules;
  argusFeeBps: number;
  takerFee: Decimal;
  logger: Logger;
  now?: () => number;
  tickMs?: number;
  /** Min gap between order actions; live is limited to 2 per second per user. */
  minActionGapMs?: number;
  /** Decisions pause while this is false (L3 book resyncing). */
  bookLive?: () => boolean;
}

export interface ExecutionEvent {
  ts: number;
  text: string;
  kind: 'info' | 'action' | 'fill' | 'warn' | 'error';
}

export interface RecordedFill {
  ts: number;
  orderId: string;
  size: string;
  price: string;
  isMaker: boolean;
  fee: string;
  /** Builder fee as charged by Strike (live), if reported. */
  builderFee?: string;
  tradeId?: number;
  checks?: Record<string, unknown>;
}

interface ExecutionEvents {
  change: [Execution];
  fill: [Execution, RecordedFill];
  done: [Execution];
}

export class Execution extends EventEmitter<ExecutionEvents> {
  readonly id: string;
  readonly owner: string | null;
  readonly params: ExecutionParams;
  readonly createdAt: number;
  state: ExecutionState = 'working';
  /** True once the report, fairness checks and venue records are final and "done" has fired. */
  settled = false;
  arrivalMid!: Decimal;
  arrivalBook!: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };
  guard!: Decimal;
  deadline!: number;
  working: WorkingOrder | null = null;
  filled = new Decimal(0);
  fills: RecordedFill[] = [];
  private rawFills: Fill[] = [];
  events: ExecutionEvent[] = [];
  report: ExecutionReport | null = null;
  /** What the exchange says about our orders (live), e.g. Builder code and fee. */
  audit: unknown = null;
  error: string | null = null;
  endedAt: number | null = null;
  private lastRepriceAt: number | null = null;
  private lastActionAt = 0;
  private lastHoldReason = '';
  private orderSeq = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly d: ExecutionDeps;
  private readonly now: () => number;

  constructor(deps: ExecutionDeps) {
    super();
    this.d = deps;
    this.id = deps.id;
    this.owner = deps.owner;
    this.params = deps.params;
    this.now = deps.now ?? Date.now;
    this.createdAt = this.now();
  }

  get remaining(): Decimal {
    return this.params.size.minus(this.filled);
  }

  get isFinished(): boolean {
    return this.state === 'done' || this.state === 'canceled' || this.state === 'failed';
  }

  /** Throws if the book is not usable or the order is invalid. */
  start(): void {
    const mid = this.d.book.mid();
    if (!mid) throw new Error('The order book is not ready yet, try again in a moment');
    const err = checkOrder(this.d.rules, this.params.size, mid.div(this.d.rules.tickSize).floor().mul(this.d.rules.tickSize));
    if (err) throw new Error(err);
    this.arrivalMid = mid;
    const depth = this.d.book.depth(20);
    const lite = (l: { key: string; total: Decimal }) => ({ price: l.key, size: l.total.toString() });
    this.arrivalBook = { bids: depth.bids.map(lite), asks: depth.asks.map(lite) };
    this.guard = priceGuard(this.params.side, mid, this.params.maxSlippageBps, this.d.rules.tickSize);
    this.deadline = this.createdAt + this.params.deadlineSec * 1000;

    this.d.venue.on('fill', (f) => this.onFill(f));
    this.d.venue.on('error', (e) => void this.fail(e.message));
    this.d.venue.on('update', () => this.emit('change', this));
    this.log('info', `Started: ${this.params.side} ${this.params.size} BTC within ${this.params.deadlineSec} s, limit ${this.guard} (arrival mid ${mid.toDecimalPlaces(2)})`);
    this.timer = setInterval(() => void this.step(), this.d.tickMs ?? 250);
    void this.step();
  }

  private log(kind: ExecutionEvent['kind'], text: string): void {
    this.events.push({ ts: this.now(), text, kind });
    if (this.events.length > 500) this.events.splice(0, 100);
    this.emit('change', this);
  }

  private onFill(f: Fill): void {
    if (this.isFinished && this.state !== 'finishing') return;
    this.rawFills.push(f);
    this.filled = this.filled.plus(f.size);
    const rec: RecordedFill = {
      ts: f.ts,
      orderId: f.orderId,
      size: f.size.toString(),
      price: f.price.toString(),
      isMaker: f.isMaker,
      fee: f.fee.toString(),
      builderFee: f.builderFee?.toString(),
      tradeId: f.tradeId,
    };
    rec.checks = f.checks; // same object; the venue fills it in later and fires 'update'
    this.fills.push(rec);
    this.log('fill', `Filled ${f.size} BTC at ${f.price} as ${f.isMaker ? 'maker' : 'taker'} (${this.filled}/${this.params.size})`);
    this.emit('fill', this, rec);
    if (this.remaining.lte(0) && this.state === 'working') void this.finish('done', 'Fully filled');
  }

  /** One decision. Exposed for tests. */
  async step(): Promise<void> {
    if (this.busy || this.state !== 'working') return;
    const now = this.now();
    if (this.d.bookLive && !this.d.bookLive()) {
      // No trustworthy book: don't make decisions. But never let an order outlive its
      // deadline because the feed is down; cancel instead of trading on stale data.
      if (now >= this.deadline) await this.stopBlind();
      return;
    }
    if (now - this.lastActionAt < (this.d.minActionGapMs ?? 500)) return;
    this.busy = true;
    try {
      const decision = this.decide(now);
      await this.act(decision, now);
    } catch (err) {
      await this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  private decide(now: number): Decision {
    const book = this.d.book;
    const w = this.working;
    const venue = this.d.venue as Venue & { isCrossed?: (o: WorkingOrder) => boolean };
    return decide({
      params: this.params,
      arrivalMid: this.arrivalMid,
      tickSize: this.d.rules.tickSize,
      bestBid: book.bestBid()?.price,
      bestAsk: book.bestAsk()?.price,
      remaining: this.remaining,
      timeLeftSec: (this.deadline - now) / 1000,
      now,
      lastRepriceAt: this.lastRepriceAt,
      working: w && !w.done ? { price: w.price, crossed: venue.isCrossed?.(w) ?? false, sizeAhead: this.d.venue.queuePosition(w).sizeAhead } : null,
      estimate: (price, asWorking) => {
        const ahead = asWorking && w ? this.d.venue.queuePosition(w).sizeAhead : undefined;
        return this.d.model.expectedFillSeconds(this.params.side, price, this.remaining, now, ahead);
      },
    });
  }

  private tooSmall(price: Decimal, kind: 'limit' | 'market'): string | null {
    return checkOrder(this.d.rules, this.remaining, price, kind);
  }

  private async act(d: Decision, now: number): Promise<void> {
    const venue = this.d.venue;
    switch (d.type) {
      case 'hold':
        if (d.reason !== this.lastHoldReason && d.reason !== 'cooldown' && d.reason !== 'done') {
          this.lastHoldReason = d.reason;
          this.emit('change', this);
        }
        return;
      case 'place':
      case 'replace': {
        const small = this.tooSmall(d.price, 'limit');
        if (small) {
          await this.cancelWorking();
          await this.finish('done', `Stopped with ${this.remaining} BTC left: ${small}`);
          return;
        }
        const clientId = `argus-${this.id}-${++this.orderSeq}`;
        this.lastActionAt = now;
        // Shown while the venue waits for the exchange to confirm the order.
        this.lastHoldReason = `Placing a post-only ${this.params.side === 'buy' ? 'bid' : 'ask'} at ${d.price}, waiting for confirmation…`;
        this.emit('change', this);
        try {
          const p = { side: this.params.side, price: d.price, size: this.remaining, clientId };
          const prev = this.working;
          this.working = d.type === 'replace' && prev && !prev.done ? await venue.replace(prev, p) : await venue.place(p);
          if (d.type === 'replace') this.lastRepriceAt = now;
          this.lastHoldReason = '';
          this.log('action', `${d.reason} → ${d.type === 'place' ? 'placed' : 'moved to'} ${d.price}`);
        } catch (err) {
          if (err instanceof PostOnlyRejected) {
            this.working = null;
            this.log('warn', `Post-only order at ${d.price} would have crossed; rechecking the book`);
            return;
          }
          throw err;
        }
        return;
      }
      case 'cancel':
        this.lastActionAt = now;
        await this.cancelWorking();
        await this.finish('done', d.reason);
        return;
      case 'cross': {
        this.state = 'finishing';
        this.lastActionAt = now;
        await this.cancelWorking();
        const ref = (this.params.side === 'buy' ? this.d.book.bestAsk() : this.d.book.bestBid())?.price ?? this.arrivalMid;
        const small = this.tooSmall(ref, 'market');
        if (small) {
          await this.finish('done', `Deadline reached with ${this.remaining} BTC left, but ${small.charAt(0).toLowerCase()}${small.slice(1)}`);
          return;
        }
        this.log('action', d.reason);
        const fills = await venue.cross({
          side: this.params.side,
          size: this.remaining,
          slippage: new Decimal(this.params.maxSlippageBps).div(10_000),
          clientId: `argus-${this.id}-m${++this.orderSeq}`,
        });
        const got = fills.reduce((s, f) => s.plus(f.size), new Decimal(0));
        await this.finish('done', got.gt(0) ? `Market order filled ${got} BTC` : 'Market order found no liquidity within your limit');
        return;
      }
    }
  }

  private async stopBlind(): Promise<void> {
    this.busy = true;
    try {
      this.state = 'finishing';
      await this.cancelWorking();
      await this.finish('done', `Deadline passed while the order book was offline. Cancelled the remaining ${this.remaining} BTC instead of trading on stale data.`);
    } catch (err) {
      await this.fail(`Deadline passed while the order book was offline and the cancel failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async cancelWorking(): Promise<void> {
    const w = this.working;
    this.working = null;
    if (w && !w.done) await this.d.venue.cancel(w);
  }

  async cancel(reason = 'Stopped by you'): Promise<void> {
    if (this.isFinished || !this.arrivalMid) return;
    this.state = 'finishing';
    try {
      await this.cancelWorking();
    } catch (err) {
      this.log('error', `Cancel failed: ${(err as Error).message}`);
    }
    await this.finish('canceled', reason);
  }

  private async fail(message: string): Promise<void> {
    if (this.isFinished) return;
    this.state = 'finishing';
    this.error = message;
    this.log('error', `Stopped: ${message}`);
    try {
      await this.cancelWorking();
    } catch (err) {
      this.log('error', `Cancel after error failed: ${(err as Error).message}`);
    }
    await this.finish('failed', message);
  }

  private async finish(state: 'done' | 'canceled' | 'failed', reason: string): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.endedAt !== null) return;
    this.endedAt = this.now();
    this.state = state;
    const levels = (this.params.side === 'buy' ? this.arrivalBook.asks : this.arrivalBook.bids).map((l) => ({ price: new Decimal(l.price), size: new Decimal(l.size) }));
    this.report = buildReport({
      side: this.params.side,
      requestedSize: this.params.size,
      arrivalMid: this.arrivalMid,
      fills: this.rawFills,
      argusFeeBps: this.d.argusFeeBps,
      takerFee: this.d.takerFee,
      arrivalOpposite: levels,
    });
    this.log(state === 'failed' ? 'error' : 'info', reason);
    // Fairness checks land a few seconds after a fill; wait for them so the saved report has them.
    for (let waited = 0; waited < 6000 && this.fills.some((f) => (f.checks as { pending?: boolean } | undefined)?.pending); waited += 200) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.d.venue.audit) {
      try {
        this.audit = await Promise.race([this.d.venue.audit(), new Promise((r) => setTimeout(() => r({ error: 'timed out' }), 8000))]);
      } catch (err) {
        this.audit = { error: (err as Error).message };
      }
    }
    this.d.venue.close();
    this.settled = true;
    this.emit('done', this);
  }

  /** Public view for the API and websocket. */
  toJSON() {
    const now = this.now();
    const w = this.working && !this.working.done ? this.working : null;
    let queue = null;
    if (w) {
      const q = this.d.venue.queuePosition(w);
      const eta = this.d.model.expectedFillSeconds(this.params.side, w.price, this.remaining, now, q.sizeAhead);
      queue = { place: q.place ?? null, sizeAhead: q.sizeAhead.toString(), estimating: q.estimating, etaSec: Number.isFinite(eta) ? Math.round(eta) : null };
    }
    return {
      id: this.id,
      mode: this.params.mode,
      side: this.params.side,
      size: this.params.size.toString(),
      deadlineSec: this.params.deadlineSec,
      maxSlippageBps: this.params.maxSlippageBps,
      preset: this.params.preset,
      fallback: this.params.fallback,
      state: this.state,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      deadline: this.deadline,
      timeLeftSec: this.isFinished ? 0 : Math.max(0, Math.round((this.deadline - now) / 1000)),
      arrivalMid: this.arrivalMid?.toString(),
      limitPrice: this.guard?.toString(),
      filled: this.filled.toString(),
      working: w ? { id: w.id, price: w.price.toString(), size: w.size.toString(), filled: w.filled.toString(), queue } : null,
      status: this.lastHoldReason || null,
      fills: this.fills,
      events: this.events.slice(-100),
      error: this.error,
      report: this.report,
      audit: this.audit,
    };
  }
}
