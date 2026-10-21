import { Decimal } from 'decimal.js';

export type Side = 'buy' | 'sell';
export type L3Action = 'open' | 'modify' | 'cancel' | 'partial_fill' | 'full_fill' | 'clear';

export interface L3Update {
  type: 'l3_update';
  symbol: string;
  action: L3Action;
  order_id?: string;
  taker_order_id?: string;
  side?: Side;
  price?: string;
  delta_size?: string;
  remaining_size?: string;
  sequence: number;
  trade_id?: number;
  timestamp: number;
}

export interface L3Snapshot {
  type: 'l3_snapshot';
  symbol: string;
  last_sequence: number;
  timestamp: number;
  bids: { price: string; orders: { order_id: string; size: string }[] }[];
  asks: { price: string; orders: { order_id: string; size: string }[] }[];
}

export interface BookOrder {
  id: string;
  size: Decimal;
  openedTs: number;
}

export interface Level {
  price: Decimal;
  key: string;
  orders: BookOrder[];
  total: Decimal;
}

/** Where an order sat in the book, captured before an update was applied. */
export interface OrderPosition {
  side: Side;
  price: Decimal;
  priceKey: string;
  /** 0 = front of the queue at its price. */
  index: number;
  size: Decimal;
  /** Size resting ahead of this order at the same price. */
  sizeAheadInLevel: Decimal;
  /** Size resting at strictly better prices on the same side. */
  sizeAtBetterPrices: Decimal;
  levelTotal: Decimal;
  /** True if its level was the best price on its side. */
  atBestPrice: boolean;
}

export type ApplyResult =
  | {
      ok: true;
      action: L3Action;
      side?: Side;
      priceKey?: string;
      orderId?: string;
      /** Position of the affected order before the update (absent for open and clear). */
      before?: OrderPosition;
      /** Size reduction for modify, cancel and fills (positive number). */
      reduced?: Decimal;
      removed?: boolean;
    }
  | { ok: false; action: L3Action; error: string };

export function priceKey(p: string | Decimal): string {
  return new Decimal(p).toString();
}

export class OrderBook {
  private bidLevels = new Map<string, Level>();
  private askLevels = new Map<string, Level>();
  /** Sorted best-first: bids descending, asks ascending. */
  private bidKeys: string[] = [];
  private askKeys: string[] = [];
  private index = new Map<string, { side: Side; priceKey: string }>();
  lastSequence = 0;
  lastTimestamp = 0;

  constructor(readonly symbol: string = 'BTC-USD') {}

  clear(): void {
    this.bidLevels.clear();
    this.askLevels.clear();
    this.bidKeys = [];
    this.askKeys = [];
    this.index.clear();
    this.lastSequence = 0;
  }

  /** Load a snapshot. Throws on malformed data (caller re-bootstraps). */
  loadSnapshot(snap: L3Snapshot): void {
    this.clear();
    const load = (side: Side, levels: L3Snapshot['bids']) => {
      for (const lvl of levels) {
        for (const o of lvl.orders) {
          const res = this.insert(side, lvl.price, o.order_id, o.size, snap.timestamp);
          if (res) throw new Error(`snapshot: ${res}`);
        }
      }
    };
    load('buy', snap.bids);
    load('sell', snap.asks);
    this.lastSequence = snap.last_sequence;
    this.lastTimestamp = snap.timestamp;
  }

  /** Apply one update. Never throws; ok:false means the book can't be trusted any more. */
  apply(u: L3Update): ApplyResult {
    try {
      return this.applyUnsafe(u);
    } catch (err) {
      return { ok: false, action: u.action, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private applyUnsafe(u: L3Update): ApplyResult {
    const fail = (error: string): ApplyResult => ({ ok: false, action: u.action, error });

    if (u.action === 'clear') {
      this.clear();
      this.lastSequence = u.sequence;
      this.lastTimestamp = u.timestamp;
      return { ok: true, action: 'clear' };
    }

    if (!u.order_id || !u.side || u.price === undefined || u.delta_size === undefined || u.remaining_size === undefined) {
      return fail(`${u.action} missing fields`);
    }
    if (u.side !== 'buy' && u.side !== 'sell') return fail(`bad side ${u.side}`);
    const key = priceKey(u.price);
    const delta = new Decimal(u.delta_size);
    const remaining = new Decimal(u.remaining_size);

    if (u.action === 'open') {
      if (!delta.gt(0)) return fail(`open with non-positive delta ${u.delta_size}`);
      if (!delta.eq(remaining)) return fail(`open delta ${u.delta_size} != remaining ${u.remaining_size}`);
      const err = this.insert(u.side, key, u.order_id, remaining, u.timestamp);
      if (err) return fail(err);
      this.lastSequence = u.sequence;
      this.lastTimestamp = u.timestamp;
      return { ok: true, action: 'open', side: u.side, priceKey: key, orderId: u.order_id };
    }

    if (u.action !== 'modify' && u.action !== 'cancel' && u.action !== 'partial_fill' && u.action !== 'full_fill') {
      return fail(`unknown action ${String(u.action)}`);
    }

    const loc = this.index.get(u.order_id);
    if (!loc) return fail(`${u.action} for unknown order ${u.order_id}`);
    if (loc.side !== u.side || loc.priceKey !== key) {
      return fail(`${u.action} for ${u.order_id} at ${u.side} ${key}, book has ${loc.side} ${loc.priceKey}`);
    }
    const before = this.positionOf(u.order_id)!;
    const level = this.levels(u.side).get(key)!;
    const order = level.orders[before.index]!;

    if (!delta.lt(0)) return fail(`${u.action} with non-negative delta ${u.delta_size}`);
    const expected = order.size.plus(delta);
    if (!expected.eq(remaining)) {
      return fail(`${u.action} ${u.order_id}: ${order.size} + ${delta} != remaining ${remaining}`);
    }
    const removing = u.action === 'cancel' || u.action === 'full_fill';
    if (removing && !remaining.isZero()) return fail(`${u.action} with remaining ${u.remaining_size}`);
    if (!removing && !remaining.gt(0)) return fail(`${u.action} leaves ${u.remaining_size}`);

    level.total = level.total.plus(delta);
    if (removing) {
      level.orders.splice(before.index, 1);
      this.index.delete(u.order_id);
      if (level.orders.length === 0) this.removeLevel(u.side, key);
    } else {
      order.size = remaining; // reduce in place, keeps queue position
    }
    this.lastSequence = u.sequence;
    this.lastTimestamp = u.timestamp;
    return {
      ok: true,
      action: u.action,
      side: u.side,
      priceKey: key,
      orderId: u.order_id,
      before,
      reduced: delta.neg(),
      removed: removing,
    };
  }

  private levels(side: Side): Map<string, Level> {
    return side === 'buy' ? this.bidLevels : this.askLevels;
  }

  private keys(side: Side): string[] {
    return side === 'buy' ? this.bidKeys : this.askKeys;
  }

  /** Returns an error string, or null on success. */
  private insert(side: Side, price: string | Decimal, id: string, size: string | Decimal, ts: number): string | null {
    if (this.index.has(id)) return `duplicate order id ${id}`;
    const sz = new Decimal(size);
    if (!sz.gt(0)) return `non-positive size ${size} for ${id}`;
    const p = new Decimal(price);
    if (!p.gt(0)) return `non-positive price ${price}`;
    const key = p.toString();
    const levels = this.levels(side);
    let level = levels.get(key);
    if (!level) {
      level = { price: p, key, orders: [], total: new Decimal(0) };
      levels.set(key, level);
      this.insertKey(side, p, key);
    }
    level.orders.push({ id, size: sz, openedTs: ts });
    level.total = level.total.plus(sz);
    this.index.set(id, { side, priceKey: key });
    return null;
  }

  private insertKey(side: Side, p: Decimal, key: string): void {
    const keys = this.keys(side);
    const levels = this.levels(side);
    // Binary search for the insert position (best first).
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const mp = levels.get(keys[mid]!)!.price;
      const better = side === 'buy' ? mp.gt(p) : mp.lt(p);
      if (better) lo = mid + 1;
      else hi = mid;
    }
    keys.splice(lo, 0, key);
  }

  private removeLevel(side: Side, key: string): void {
    this.levels(side).delete(key);
    const keys = this.keys(side);
    const i = keys.indexOf(key);
    if (i >= 0) keys.splice(i, 1);
  }

  bestBid(): Level | undefined {
    const k = this.bidKeys[0];
    return k === undefined ? undefined : this.bidLevels.get(k);
  }

  bestAsk(): Level | undefined {
    const k = this.askKeys[0];
    return k === undefined ? undefined : this.askLevels.get(k);
  }

  best(side: Side): Level | undefined {
    return side === 'buy' ? this.bestBid() : this.bestAsk();
  }

  mid(): Decimal | undefined {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return undefined;
    return b.price.plus(a.price).div(2);
  }

  spread(): Decimal | undefined {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return undefined;
    return a.price.minus(b.price);
  }

  level(side: Side, price: string | Decimal): Level | undefined {
    return this.levels(side).get(priceKey(price));
  }

  /** Levels on one side, best first. */
  sideLevels(side: Side, n = Infinity): Level[] {
    const keys = this.keys(side);
    const levels = this.levels(side);
    const out: Level[] = [];
    for (let i = 0; i < keys.length && i < n; i++) out.push(levels.get(keys[i]!)!);
    return out;
  }

  depth(n: number): { bids: Level[]; asks: Level[] } {
    return { bids: this.sideLevels('buy', n), asks: this.sideLevels('sell', n) };
  }

  hasOrder(id: string): boolean {
    return this.index.has(id);
  }

  orderCount(): number {
    return this.index.size;
  }

  /** Total resting size at prices strictly better than `price` on `side`. */
  sizeBetterThan(side: Side, price: string | Decimal): Decimal {
    const p = new Decimal(price);
    let total = new Decimal(0);
    for (const lvl of this.sideLevels(side)) {
      const better = side === 'buy' ? lvl.price.gt(p) : lvl.price.lt(p);
      if (!better) break;
      total = total.plus(lvl.total);
    }
    return total;
  }

  positionOf(id: string): OrderPosition | undefined {
    const loc = this.index.get(id);
    if (!loc) return undefined;
    const level = this.levels(loc.side).get(loc.priceKey);
    if (!level) return undefined;
    let ahead = new Decimal(0);
    for (let i = 0; i < level.orders.length; i++) {
      const o = level.orders[i]!;
      if (o.id === id) {
        return {
          side: loc.side,
          price: level.price,
          priceKey: loc.priceKey,
          index: i,
          size: o.size,
          sizeAheadInLevel: ahead,
          sizeAtBetterPrices: this.sizeBetterThan(loc.side, level.price),
          levelTotal: level.total,
          atBestPrice: this.keys(loc.side)[0] === loc.priceKey,
        };
      }
      ahead = ahead.plus(o.size);
    }
    return undefined;
  }

  /** Plain-JSON form for comparisons and the API. */
  toJSON(n = Infinity) {
    const ser = (lvls: Level[]) =>
      lvls.map((l) => ({ price: l.key, total: l.total.toString(), orders: l.orders.map((o) => ({ id: o.id, size: o.size.toString() })) }));
    return {
      symbol: this.symbol,
      sequence: this.lastSequence,
      timestamp: this.lastTimestamp,
      bids: ser(this.sideLevels('buy', n)),
      asks: ser(this.sideLevels('sell', n)),
    };
  }
}
