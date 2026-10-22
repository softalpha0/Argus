import { EventEmitter } from 'node:events';
import { Decimal } from 'decimal.js';
import type { Logger } from 'pino';
import type { L3Update, OrderBook, Side } from '../book/OrderBook.js';
import type { L3Client } from '../strike/l3Client.js';
import type { TapeClient } from '../strike/tapeClient.js';
import { StrikeError, type CreateOrderBody, type StrikeRest } from '../strike/rest.js';
import type { OrderTradeUpdate, UserStream } from '../strike/userStream.js';
import { FillChecks } from '../fairness/FillChecks.js';
import { PostOnlyRejected, type CrossParams, type Fill, type PlaceParams, type QueuePosition, type Venue, type VenueEvents, type WorkingOrder } from './Venue.js';

export interface LiveVenueDeps {
  symbol: string;
  rest: StrikeRest;
  stream: UserStream;
  l3: L3Client;
  tape: TapeClient;
  argusFeeBps: number;
  logger: Logger;
  /** Max order actions per second for this user. */
  maxActionsPerSec?: number;
  ackTimeoutMs?: number;
}

interface Tracked {
  order: WorkingOrder;
  postOnly: boolean;
  /** Resolves on NEW, rejects on a terminal event before NEW. */
  ack: Deferred<void>;
  /** Resolves on any terminal status. */
  terminal: Deferred<'filled' | 'canceled' | 'rejected'>;
  acked: boolean;
  closedReason?: string;
  linkTimer?: NodeJS.Timeout;
  cancelRequested: boolean;
}

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  settled = false;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = (v) => {
        if (!this.settled) {
          this.settled = true;
          res(v);
        }
      };
      this.reject = (e) => {
        if (!this.settled) {
          this.settled = true;
          rej(e);
        }
      };
    });
    this.promise.catch(() => {}); // avoid unhandled rejections if nobody awaits
  }
}

const POST_ONLY_HINT = /post.?only|would (immediately )?(match|cross|take)|maker.?only/i;

const withTimeout = <T>(p: Promise<T>, ms: number, msg: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

/**
 * Real orders on Strike through the user's API wallet, carrying Argus's builder fee.
 * Fills come from the user stream; queue position from the order's public L3 entry.
 */
export class LiveVenue extends EventEmitter<VenueEvents> implements Venue {
  readonly mode = 'live' as const;
  private tracked = new Map<string, Tracked>();
  private actionTimes: number[] = [];
  private recentOpens: { u: L3Update; at: number }[] = [];
  private readonly checks = new FillChecks();
  private readonly publicIds = new Set<string>();
  private readonly book: OrderBook;
  private readonly onOrder = (e: OrderTradeUpdate) => this.handleOrderEvent(e);
  private readonly onBefore = (u: L3Update, book: OrderBook) => this.checks.observe(u, book, this.publicIds);
  private readonly onL3 = (u: L3Update) => this.onL3Update(u);
  private readonly onStreamDown = (reason: string) => {
    // Without the stream we can't see fills; stop rather than trade blind.
    if (this.tracked.size) this.emit('error', new Error(`Lost the connection to your Strike account (${reason})`));
  };
  private closed = false;
  private readonly everPlaced = new Set<string>();

  constructor(private readonly d: LiveVenueDeps) {
    super();
    this.book = d.l3.book;
    d.stream.on('order', this.onOrder);
    d.stream.on('down', this.onStreamDown);
    d.l3.on('beforeUpdate', this.onBefore);
    d.l3.on('update', this.onL3);
  }

  private async rateLimit(): Promise<void> {
    const max = this.d.maxActionsPerSec ?? 2;
    for (;;) {
      const now = Date.now();
      this.actionTimes = this.actionTimes.filter((t) => now - t < 1000);
      if (this.actionTimes.length < max) {
        this.actionTimes.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 - (now - this.actionTimes[0]!) + 5));
    }
  }

  private body(p: PlaceParams): CreateOrderBody {
    return { symbol: this.d.symbol, side: p.side, type: 'limit', size: p.size.toString(), price: p.price.toString(), time_in_force: 'GTC', post_only: true, client_order_id: p.clientId };
  }

  private track(p: { clientId: string; side: Side; price: Decimal; size: Decimal }, postOnly: boolean): Tracked {
    const t: Tracked = {
      order: { id: p.clientId, side: p.side, price: p.price, size: p.size, filled: new Decimal(0), placedAt: Date.now(), done: false },
      postOnly,
      ack: new Deferred<void>(),
      terminal: new Deferred(),
      acked: false,
      cancelRequested: false,
    };
    this.tracked.set(p.clientId, t);
    this.everPlaced.add(p.clientId);
    return t;
  }

  private untrack(t: Tracked): void {
    if (t.linkTimer) clearTimeout(t.linkTimer);
    if (t.order.publicId) this.publicIds.delete(t.order.publicId);
    this.tracked.delete(t.order.id);
  }

  async place(p: PlaceParams): Promise<WorkingOrder> {
    await this.rateLimit();
    const t = this.track(p, true);
    try {
      await this.d.rest.createOrder(this.body(p), this.d.argusFeeBps);
    } catch (err) {
      this.untrack(t);
      if (err instanceof StrikeError && POST_ONLY_HINT.test(err.message)) throw new PostOnlyRejected(err.message);
      throw err;
    }
    await this.awaitAck(t);
    return t.order;
  }

  private async awaitAck(t: Tracked): Promise<void> {
    try {
      await withTimeout(t.ack.promise, this.d.ackTimeoutMs ?? 8000, 'Strike did not confirm the order in time');
    } catch (err) {
      if (err instanceof PostOnlyRejected) {
        this.untrack(t);
        throw err;
      }
      // No NEW seen: ask the REST API what happened before giving up.
      const status = await this.lookup(t.order.id).catch(() => null);
      if (status && typeof status.ID === 'number') {
        t.order.exchangeId = status.ID;
        const st = String(status.Status ?? '');
        if (st === 'open' || st === 'pending' || st === 'filled') {
          t.acked = true;
          this.scheduleLink(t);
          return;
        }
        this.untrack(t);
        if (t.postOnly && (st === 'canceled' || st === 'expired')) throw new PostOnlyRejected(`Order ${st}: ${String(status.CloseReason ?? 'post-only would have crossed')}`);
        throw new Error(`Order was ${st || 'not accepted'}${status.CloseReason ? `: ${String(status.CloseReason)}` : ''}`);
      }
      this.untrack(t);
      throw err;
    }
  }

  private lookup(clientId: string) {
    return this.d.rest.getOrderByClientId(this.d.symbol, clientId);
  }

  async replace(order: WorkingOrder, p: PlaceParams): Promise<WorkingOrder> {
    const old = this.tracked.get(order.id);
    if (!old || order.exchangeId === undefined) {
      await this.cancel(order);
      return this.place(p);
    }
    await this.rateLimit();
    old.cancelRequested = true;
    const t = this.track(p, true);
    try {
      await this.d.rest.replaceOrder({ order_id: order.exchangeId, symbol: this.d.symbol }, this.body(p), this.d.argusFeeBps);
    } catch (err) {
      this.untrack(t);
      old.cancelRequested = false;
      if (err instanceof StrikeError && POST_ONLY_HINT.test(err.message)) throw new PostOnlyRejected(err.message);
      throw err;
    }
    // The old order's cancel arrives on the stream; don't block on it.
    await this.awaitAck(t);
    return t.order;
  }

  async cancel(order: WorkingOrder): Promise<void> {
    const t = this.tracked.get(order.id);
    if (!t || order.done) return;
    t.cancelRequested = true;
    if (order.exchangeId === undefined) {
      const st = await this.lookup(order.id).catch(() => null);
      if (st && typeof st.ID === 'number') order.exchangeId = st.ID;
    }
    if (order.exchangeId === undefined) throw new Error(`Could not find order ${order.id} to cancel it`);
    await this.rateLimit();
    try {
      await this.d.rest.cancelOrder(order.exchangeId, this.d.symbol);
    } catch (err) {
      // Already filled or gone is fine; anything else is an error.
      if (!(err instanceof StrikeError && /not found|already|filled|closed|canceled|cancelled/i.test(err.message))) throw err;
    }
    await withTimeout(t.terminal.promise, 8000, 'Strike did not confirm the cancel in time').catch(async (err) => {
      const st = await this.lookup(order.id).catch(() => null);
      if (st && ['canceled', 'filled', 'expired', 'rejected'].includes(String(st.Status))) return;
      throw err;
    });
  }

  async cross(p: CrossParams): Promise<Fill[]> {
    await this.rateLimit();
    const t = this.track({ clientId: p.clientId, side: p.side, price: new Decimal(0), size: p.size }, false);
    const fills: Fill[] = [];
    const collect = (f: Fill) => {
      if (f.orderId === p.clientId) fills.push(f);
    };
    this.on('fill', collect);
    try {
      await this.d.rest.createOrder(
        { symbol: this.d.symbol, side: p.side, type: 'market', size: p.size.toString(), slippage: p.slippage.toString(), client_order_id: p.clientId },
        this.d.argusFeeBps,
      );
      await withTimeout(t.terminal.promise, 10_000, 'Market order did not finish in time').catch(() => undefined);
    } finally {
      this.off('fill', collect);
      if (t.terminal.settled) this.untrack(t);
    }
    return fills;
  }

  queuePosition(order: WorkingOrder): QueuePosition {
    const better = this.book.sizeBetterThan(order.side, order.price);
    if (order.publicId) {
      const pos = this.book.positionOf(order.publicId);
      if (pos) return { place: pos.index + 1, sizeAhead: pos.sizeAheadInLevel.plus(better), estimating: false };
    }
    // Not linked yet: try the book once more, else assume we are at the back of our level.
    const t = this.tracked.get(order.id);
    if (t && t.acked && this.tryLink(t)) return this.queuePosition(order);
    const level = this.book.level(order.side, order.price);
    let ahead = level?.total ?? new Decimal(0);
    if (level) ahead = ahead.minus(order.size.minus(order.filled)).clamp(0, Infinity);
    return { sizeAhead: ahead.plus(better), estimating: true };
  }

  async audit(): Promise<unknown> {
    const ids = [...this.everPlaced];
    const out: unknown[] = [];
    for (const id of ids.slice(-10)) {
      try {
        const o = await this.lookup(id);
        out.push({ clientOrderId: id, id: o.ID, status: o.Status, type: o.Type, price: o.Price, size: o.Size, filled: o.Filled, postOnly: o.PostOnly, builder: o.Builder ?? null });
      } catch (err) {
        out.push({ clientOrderId: id, error: (err as Error).message });
      }
    }
    return { orders: out };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.d.stream.off('order', this.onOrder);
    this.d.stream.off('down', this.onStreamDown);
    this.d.l3.off('beforeUpdate', this.onBefore);
    this.d.l3.off('update', this.onL3);
    for (const t of this.tracked.values()) if (t.linkTimer) clearTimeout(t.linkTimer);
    this.tracked.clear();
    this.removeAllListeners();
  }

  // --- stream handling -----------------------------------------------------

  private handleOrderEvent(e: OrderTradeUpdate): void {
    const t = this.tracked.get(e.c);
    if (!t) return;
    this.everPlaced.add(e.c);
    const o = t.order;
    if (typeof e.i === 'number' && e.i > 0) o.exchangeId = e.i;

    if (e.x === 'NEW') {
      t.acked = true;
      t.ack.resolve();
      if (t.postOnly) this.scheduleLink(t);
      return;
    }

    if (e.x === 'TRADE') {
      if (!t.acked) {
        t.acked = true;
        t.ack.resolve();
      }
      const size = new Decimal(e.l || '0');
      if (size.gt(0)) {
        const price = new Decimal(e.L);
        o.filled = new Decimal(e.z || o.filled.plus(size));
        const fill: Fill = { orderId: o.id, size, price, isMaker: e.m === true, fee: new Decimal(e.n || '0'), tradeId: e.t || undefined, ts: e.T || Date.now(), checks: { pending: true } };
        this.emit('fill', fill);
        if (t.postOnly) this.scheduleChecks(fill, !!o.publicId);
      }
      if (e.X === 'FILLED') this.finish(t, 'filled');
      return;
    }

    if (e.x === 'CANCELED' || e.x === 'EXPIRED' || e.x === 'REJECTED') {
      const reason = e.cr || e.x;
      if (!t.acked) {
        t.ack.reject(t.postOnly && (e.x !== 'REJECTED' || POST_ONLY_HINT.test(reason)) ? new PostOnlyRejected(`Post-only order ${e.x.toLowerCase()}: ${reason}`) : new Error(`Order ${e.x.toLowerCase()}: ${reason}`));
      }
      this.finish(t, e.x === 'REJECTED' ? 'rejected' : 'canceled');
    }
  }

  private finish(t: Tracked, why: 'filled' | 'canceled' | 'rejected'): void {
    if (t.order.done) return;
    t.order.done = true;
    t.terminal.resolve(why);
    this.untrack(t);
    // Our own cancels/replaces are expected; an unexpected close tells the execution to re-place.
    this.emit('orderDone', t.order, why);
  }

  /** Fairness checks once the matching L3 and tape events have had time to arrive. */
  private scheduleChecks(fill: Fill, linked: boolean): void {
    setTimeout(() => {
      const res = this.checks.evaluate(fill, linked, this.d.tape.trades);
      if (fill.checks) {
        delete fill.checks.pending;
        Object.assign(fill.checks, res);
      }
      if (!this.closed) this.emit('update');
    }, 3000).unref();
  }

  // --- L3 linking ------------------------------------------------------------

  private onL3Update(u: L3Update): void {
    if (u.action !== 'open') return;
    const now = Date.now();
    this.recentOpens.push({ u, at: now });
    while (this.recentOpens.length && now - this.recentOpens[0]!.at > 5000) this.recentOpens.shift();
    for (const t of this.tracked.values()) if (t.acked && t.postOnly && !t.order.publicId) this.tryLink(t);
  }

  /** Find the public L3 open for our order: same side, price and size within 3 s of NEW. */
  private tryLink(t: Tracked): boolean {
    const o = t.order;
    const key = o.price.toString();
    const size = o.size.toString();
    const taken = this.publicIds;
    const match = this.recentOpens.find(
      ({ u, at }) =>
        u.side === o.side &&
        u.price !== undefined &&
        new Decimal(u.price).toString() === key &&
        u.delta_size !== undefined &&
        new Decimal(u.delta_size).toString() === size &&
        Math.abs(at - o.placedAt) <= 3000 + (this.d.ackTimeoutMs ?? 8000) &&
        !taken.has(u.order_id!) &&
        this.book.hasOrder(u.order_id!),
    );
    const id = match?.u.order_id ?? this.findInBook(o);
    if (!id) return false;
    o.publicId = id;
    this.publicIds.add(o.publicId);
    if (t.linkTimer) clearTimeout(t.linkTimer);
    this.d.logger.info({ order: o.id, publicId: o.publicId, via: match ? 'open event' : 'book scan' }, 'linked order to L3');
    this.emit('update');
    return true;
  }

  /**
   * Backup link: an order at our price, with our remaining size, that appeared around the time we
   * placed ours and is not already someone else's link. Only links when exactly one fits.
   * Book timestamps are engine time, so allow some clock skew.
   */
  private findInBook(o: WorkingOrder): string | undefined {
    const level = this.book.level(o.side, o.price);
    if (!level) return undefined;
    const remaining = o.size.minus(o.filled);
    const fits = level.orders.filter((x) => x.size.eq(remaining) && !this.publicIds.has(x.id) && x.openedTs >= o.placedAt - 10_000);
    return fits.length === 1 ? fits[0]!.id : undefined;
  }

  private scheduleLink(t: Tracked): void {
    if (this.tryLink(t)) return;
    t.linkTimer = setTimeout(() => {
      if (t.order.publicId || this.tryLink(t)) return;
      const o = t.order;
      const level = this.book.level(o.side, o.price);
      this.d.logger.info(
        {
          order: o.id,
          side: o.side,
          price: o.price.toString(),
          size: o.size.toString(),
          levelOrders: level?.orders.map((x) => ({ size: x.size.toString(), openedTs: x.openedTs })) ?? [],
          placedAt: o.placedAt,
          recentOpensAtPrice: this.recentOpens.filter(({ u }) => u.price !== undefined && new Decimal(u.price).eq(o.price)).map(({ u }) => u.delta_size),
        },
        'could not link order to L3; showing estimated position',
      );
    }, 3000);
    t.linkTimer.unref();
  }
}
