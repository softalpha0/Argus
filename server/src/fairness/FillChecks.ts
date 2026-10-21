import { Decimal } from 'decimal.js';
import type { L3Update, OrderBook } from '../book/OrderBook.js';
import type { TapeTrade } from '../strike/tapeClient.js';

export type CheckResult = 'pass' | 'fail' | 'unknown';

export interface FillCheckSet {
  /** Our order was at the best price on its side just before the fill. */
  bestPrice: CheckResult;
  /** Our order was first in line at its price just before the fill. */
  firstInLine: CheckResult;
  /** A trade with this ID (or same price and size within 5 s) is on the public tape. */
  onTape: CheckResult;
  /** How the order was matched to its public L3 entry; checks are 'unknown' without it. */
  linked: boolean;
  note?: string;
}

interface Seen {
  atBest: boolean;
  index: number;
}

/** Records our order's L3 position just before each fill so live fills can be checked. Pure. */
export class FillChecks {
  /** trade_id → our order's position right before that trade touched it. */
  private beforeFill = new Map<number, Seen>();
  private order: string[] = [];

  /** Call from L3Client 'beforeUpdate' with the public IDs of our working orders. */
  observe(u: L3Update, book: OrderBook, ourPublicIds: ReadonlySet<string>): void {
    if ((u.action !== 'partial_fill' && u.action !== 'full_fill') || u.trade_id === undefined || !u.order_id) return;
    if (!ourPublicIds.has(u.order_id)) return;
    const pos = book.positionOf(u.order_id);
    if (!pos) return;
    this.beforeFill.set(u.trade_id, { atBest: pos.atBestPrice, index: pos.index });
    this.order.push(String(u.trade_id));
    if (this.order.length > 1000) this.beforeFill.delete(Number(this.order.shift()));
  }

  evaluate(fill: { tradeId?: number; price: Decimal; size: Decimal; ts: number }, linked: boolean, tape: readonly TapeTrade[]): FillCheckSet {
    const seen = fill.tradeId !== undefined ? this.beforeFill.get(fill.tradeId) : undefined;
    const onTapeMatch = tape.some((t) => (fill.tradeId !== undefined && t.id === fill.tradeId) || (t.price.eq(fill.price) && t.size.eq(fill.size) && Math.abs(t.time - fill.ts) <= 5000));
    const res: FillCheckSet = {
      bestPrice: seen ? (seen.atBest ? 'pass' : 'fail') : 'unknown',
      firstInLine: seen ? (seen.index === 0 ? 'pass' : 'fail') : 'unknown',
      onTape: onTapeMatch ? 'pass' : 'fail',
      linked,
    };
    if (!linked) res.note = 'Our order was not matched to its public L3 entry, so queue checks could not run.';
    else if (!seen) res.note = 'No L3 fill event for this trade was seen on our order.';
    return res;
  }
}
