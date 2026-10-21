import { EventEmitter } from 'node:events';
import { Decimal } from 'decimal.js';
import type { ApplyResult, L3Update, OrderBook } from '../book/OrderBook.js';
import { PostOnlyRejected, type CrossParams, type Fill, type PlaceParams, type QueuePosition, type Venue, type VenueEvents, type WorkingOrder } from './Venue.js';

interface PaperState {
  order: WorkingOrder;
  key: string;
  /** Public IDs resting ahead of us at our price, with their current size, in FIFO order. */
  ahead: Map<string, Decimal>;
}

export interface PaperVenueOptions {
  makerFee: Decimal.Value;
  takerFee: Decimal.Value;
  now?: () => number;
}

/**
 * Simulates orders against the live L3 book. Our order joins the back of the real
 * queue and is filled only by real trades that would have reached it:
 *
 * - trades on orders that were ahead of us use up the queue ahead;
 * - a trade at our price on an order that queued behind us, or at a worse price
 *   on our side, would have hit us first, so it fills us.
 *
 * Only real trades fill us. An opposite order that rests at our price (usually a
 * market maker re-quoting) is not counted: if it was post-only it would have been
 * rejected rather than matched, and L3 can't tell us which. The order is reported
 * as crossed instead so the strategy can re-place it. Cancels and size reductions
 * ahead of us move us up without filling us.
 */
export class PaperVenue extends EventEmitter<VenueEvents> implements Venue {
  readonly mode = 'paper' as const;
  private states = new Map<string, PaperState>();
  private readonly makerFee: Decimal;
  private readonly takerFee: Decimal;
  private readonly now: () => number;

  constructor(private readonly book: OrderBook, opts: PaperVenueOptions) {
    super();
    this.makerFee = new Decimal(opts.makerFee);
    this.takerFee = new Decimal(opts.takerFee);
    this.now = opts.now ?? Date.now;
  }

  async place(p: PlaceParams): Promise<WorkingOrder> {
    const opp = p.side === 'buy' ? this.book.bestAsk() : this.book.bestBid();
    if (opp && (p.side === 'buy' ? p.price.gte(opp.price) : p.price.lte(opp.price))) throw new PostOnlyRejected();
    const level = this.book.level(p.side, p.price);
    const ahead = new Map<string, Decimal>();
    for (const o of level?.orders ?? []) ahead.set(o.id, o.size);
    const order: WorkingOrder = { id: p.clientId, side: p.side, price: p.price, size: p.size, filled: new Decimal(0), placedAt: this.now(), done: false };
    this.states.set(order.id, { order, key: p.price.toString(), ahead });
    return order;
  }

  async replace(order: WorkingOrder, p: PlaceParams): Promise<WorkingOrder> {
    await this.cancel(order);
    return this.place(p);
  }

  async cancel(order: WorkingOrder): Promise<void> {
    const st = this.states.get(order.id);
    if (!st) return;
    this.states.delete(order.id);
    order.done = true;
    this.emit('orderDone', order, 'canceled');
  }

  async cross(p: CrossParams): Promise<Fill[]> {
    const oppSide = p.side === 'buy' ? 'sell' : 'buy';
    const levels = this.book.sideLevels(oppSide);
    const first = levels[0];
    if (!first) return [];
    const limit = p.side === 'buy' ? first.price.mul(new Decimal(1).plus(p.slippage)) : first.price.mul(new Decimal(1).minus(p.slippage));
    let left = p.size;
    const fills: Fill[] = [];
    const ts = this.now();
    for (const lvl of levels) {
      if (left.lte(0)) break;
      if (p.side === 'buy' ? lvl.price.gt(limit) : lvl.price.lt(limit)) break;
      const take = Decimal.min(left, lvl.total);
      left = left.minus(take);
      const fill: Fill = { orderId: p.clientId, size: take, price: lvl.price, isMaker: false, fee: take.mul(lvl.price).mul(this.takerFee), ts };
      fills.push(fill);
      this.emit('fill', fill);
    }
    return fills;
  }

  queuePosition(order: WorkingOrder): QueuePosition {
    const st = this.states.get(order.id);
    if (!st) return { sizeAhead: new Decimal(0), estimating: false };
    let inLevel = new Decimal(0);
    for (const s of st.ahead.values()) inLevel = inLevel.plus(s);
    return { place: st.ahead.size + 1, sizeAhead: inLevel.plus(this.book.sizeBetterThan(order.side, order.price)), estimating: false };
  }

  close(): void {
    this.states.clear();
    this.removeAllListeners();
  }

  /** Feed every applied L3 update, after the book has applied it. */
  onUpdate(u: L3Update, res: ApplyResult): void {
    if (!res.ok || !res.side || !res.priceKey) return;
    for (const st of [...this.states.values()]) {
      const o = st.order;
      const price = new Decimal(res.priceKey);

      if (res.side !== o.side) continue;

      const isFill = u.action === 'partial_fill' || u.action === 'full_fill';
      const reduced = res.reduced ?? new Decimal(0);
      if (res.priceKey === st.key) {
        const id = res.orderId!;
        const aheadSize = st.ahead.get(id);
        if (aheadSize !== undefined) {
          if (res.removed) st.ahead.delete(id);
          else st.ahead.set(id, aheadSize.minus(reduced));
        } else if (isFill) {
          // A taker reached an order behind us, so it went through us first.
          this.fillUs(st, reduced, u);
        }
      } else if (isFill && (o.side === 'buy' ? price.lt(o.price) : price.gt(o.price))) {
        // A trade at a worse price on our side swept past our level.
        this.fillUs(st, reduced, u);
      }
    }
  }

  /** True if the opposite side now rests at or through our price (paper only). */
  isCrossed(order: WorkingOrder): boolean {
    const opp = order.side === 'buy' ? this.book.bestAsk() : this.book.bestBid();
    return !!opp && (order.side === 'buy' ? opp.price.lte(order.price) : opp.price.gte(order.price));
  }

  /**
   * After the L3 book was rebuilt we missed whatever happened in between. Orders
   * ahead that are gone are dropped, but we never invent fills.
   */
  onResync(): void {
    for (const st of this.states.values()) {
      for (const id of [...st.ahead.keys()]) {
        const pos = this.book.positionOf(id);
        if (!pos || pos.priceKey !== st.key) st.ahead.delete(id);
        else st.ahead.set(id, pos.size);
      }
    }
  }

  private fillUs(st: PaperState, available: Decimal, u: L3Update): void {
    const o = st.order;
    const remaining = o.size.minus(o.filled);
    const size = Decimal.min(remaining, available);
    if (size.lte(0)) return;
    o.filled = o.filled.plus(size);
    const fill: Fill = {
      orderId: o.id,
      size,
      price: o.price,
      isMaker: true,
      fee: size.mul(o.price).mul(this.makerFee),
      tradeId: u.trade_id,
      ts: u.timestamp,
    };
    this.emit('fill', fill);
    if (o.filled.gte(o.size)) {
      o.done = true;
      this.states.delete(o.id);
      this.emit('orderDone', o, 'filled');
    }
  }
}
