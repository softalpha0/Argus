import { Decimal } from 'decimal.js';
import type { ApplyResult, L3Update, OrderBook, Side } from '../book/OrderBook.js';

export interface FillRecord {
  /** Side of the resting order that was filled. */
  side: Side;
  priceKey: string;
  size: Decimal;
  ts: number;
}

export interface MarketModelOptions {
  /** EWMA time constant for fill rates. */
  tauMs?: number;
  /** How long raw fills are kept for per-level stats. */
  retainMs?: number;
}

/**
 * Queue and fill-rate view over an OrderBook. Pure: fed with updates, no I/O.
 * Time comes from update timestamps and the `now` passed to queries.
 */
export class MarketModel {
  private readonly tauMs: number;
  private readonly retainMs: number;
  private ewma: Record<Side, number> = { buy: 0, sell: 0 };
  private lastDecayTs: number | null = null;
  private firstTs: number | null = null;
  private fills: FillRecord[] = [];

  constructor(readonly book: OrderBook, opts: MarketModelOptions = {}) {
    this.tauMs = opts.tauMs ?? 180_000;
    this.retainMs = opts.retainMs ?? 10 * 60_000;
  }

  /** Feed every applied L3 update. */
  onUpdate(u: L3Update, res: ApplyResult): void {
    if (!res.ok) return;
    if (this.firstTs === null) this.firstTs = u.timestamp;
    if (u.action !== 'partial_fill' && u.action !== 'full_fill') return;
    if (!res.side || !res.reduced || !res.priceKey) return;
    this.decayTo(u.timestamp);
    this.ewma[res.side] += res.reduced.toNumber();
    this.fills.push({ side: res.side, priceKey: res.priceKey, size: res.reduced, ts: u.timestamp });
    const cutoff = u.timestamp - this.retainMs;
    let drop = 0;
    while (drop < this.fills.length && this.fills[drop]!.ts < cutoff) drop++;
    if (drop) this.fills.splice(0, drop);
  }

  /** Start the clock (e.g. on sync) so rates are not inflated by a short history. */
  markStart(ts: number): void {
    if (this.firstTs === null) this.firstTs = ts;
  }

  private decayTo(ts: number): void {
    if (this.lastDecayTs !== null && ts > this.lastDecayTs) {
      const k = Math.exp(-(ts - this.lastDecayTs) / this.tauMs);
      this.ewma.buy *= k;
      this.ewma.sell *= k;
    }
    if (this.lastDecayTs === null || ts > this.lastDecayTs) this.lastDecayTs = ts;
  }

  /**
   * Resting `side` orders filled per second (BTC/s), EWMA over ~tau.
   * Bias-corrected for short histories: with constant rate r, the decayed sum
   * after t ms is r·tau·(1 − e^(−t/tau)).
   */
  fillRate(side: Side, now: number): number {
    if (this.firstTs === null) return 0;
    const since = this.lastDecayTs ?? now;
    const decayed = this.ewma[side] * Math.exp(-Math.max(0, now - since) / this.tauMs);
    const elapsed = Math.max(1000, now - this.firstTs);
    const window = this.tauMs * (1 - Math.exp(-elapsed / this.tauMs));
    return decayed / (window / 1000);
  }

  /** Total resting size at a price; a new order there would queue behind all of it. */
  queueAhead(side: Side, price: string | Decimal): Decimal {
    return this.book.level(side, price)?.total ?? new Decimal(0);
  }

  /** Size that must trade before a new order at `price` is reached: its level plus better prices. */
  sizeAheadAt(side: Side, price: string | Decimal): Decimal {
    return this.queueAhead(side, price).plus(this.book.sizeBetterThan(side, price));
  }

  /** Size before an existing public order: ahead in its level plus better prices. */
  sizeAheadOf(orderId: string): Decimal | undefined {
    const p = this.book.positionOf(orderId);
    if (!p) return undefined;
    return p.sizeAheadInLevel.plus(p.sizeAtBetterPrices);
  }

  /** Seconds until a new order at `price` would be fully filled at the current fill rate. */
  expectedFillSeconds(side: Side, price: string | Decimal, ourSize: Decimal.Value, now: number, aheadOverride?: Decimal): number {
    const rate = this.fillRate(side, now);
    if (rate < 1e-9) return Infinity;
    const ahead = aheadOverride ?? this.sizeAheadAt(side, price);
    return ahead.plus(ourSize).toNumber() / rate;
  }

  /** Volume filled per price level within the last `windowMs`. */
  fillsByLevel(side: Side, now: number, windowMs = 5 * 60_000): Map<string, Decimal> {
    const out = new Map<string, Decimal>();
    for (const f of this.fills) {
      if (f.side !== side || f.ts < now - windowMs) continue;
      out.set(f.priceKey, (out.get(f.priceKey) ?? new Decimal(0)).plus(f.size));
    }
    return out;
  }

  recentFills(now: number, windowMs = 60_000): FillRecord[] {
    return this.fills.filter((f) => f.ts >= now - windowMs);
  }
}
