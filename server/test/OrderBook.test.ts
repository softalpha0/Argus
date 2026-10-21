import { describe, expect, it } from 'vitest';
import { OrderBook, type L3Snapshot, type L3Update } from '../src/book/OrderBook.js';

const snap = (): L3Snapshot => ({
  type: 'l3_snapshot',
  symbol: 'BTC-USD',
  last_sequence: 100,
  timestamp: 1000,
  bids: [
    { price: '100.0', orders: [{ order_id: 'b1', size: '1' }, { order_id: 'b2', size: '2' }] },
    { price: '99', orders: [{ order_id: 'b3', size: '0.5' }] },
  ],
  asks: [
    { price: '101', orders: [{ order_id: 'a1', size: '1.5' }] },
    { price: '102.00', orders: [{ order_id: 'a2', size: '3' }] },
  ],
});

let seq = 100;
const up = (p: Partial<L3Update>): L3Update => ({ type: 'l3_update', symbol: 'BTC-USD', sequence: ++seq, timestamp: 2000, action: 'open', ...p }) as L3Update;

function book() {
  seq = 100;
  const b = new OrderBook();
  b.loadSnapshot(snap());
  return b;
}

describe('OrderBook', () => {
  it('loads a snapshot with normalized price keys and FIFO order', () => {
    const b = book();
    expect(b.bestBid()!.key).toBe('100');
    expect(b.bestAsk()!.key).toBe('101');
    expect(b.level('buy', '100.00')!.orders.map((o) => o.id)).toEqual(['b1', 'b2']);
    expect(b.level('buy', '100')!.total.toString()).toBe('3');
    expect(b.mid()!.toString()).toBe('100.5');
    expect(b.spread()!.toString()).toBe('1');
    expect(b.lastSequence).toBe(100);
    expect(b.orderCount()).toBe(5);
  });

  it('open appends to the back of the FIFO', () => {
    const b = book();
    const r = b.apply(up({ action: 'open', order_id: 'b4', side: 'buy', price: '100', delta_size: '0.3', remaining_size: '0.3' }));
    expect(r.ok).toBe(true);
    expect(b.level('buy', '100')!.orders.map((o) => o.id)).toEqual(['b1', 'b2', 'b4']);
    expect(b.positionOf('b4')!.sizeAheadInLevel.toString()).toBe('3');
    expect(b.lastSequence).toBe(101);
  });

  it('open at a new price creates a level in sorted position', () => {
    const b = book();
    b.apply(up({ action: 'open', order_id: 'b5', side: 'buy', price: '99.5', delta_size: '1', remaining_size: '1' }));
    b.apply(up({ action: 'open', order_id: 'a3', side: 'sell', price: '100.5', delta_size: '1', remaining_size: '1' }));
    expect(b.sideLevels('buy').map((l) => l.key)).toEqual(['100', '99.5', '99']);
    expect(b.sideLevels('sell').map((l) => l.key)).toEqual(['100.5', '101', '102']);
    expect(b.bestAsk()!.key).toBe('100.5');
  });

  it('modify reduces in place and keeps queue position', () => {
    const b = book();
    const r = b.apply(up({ action: 'modify', order_id: 'b1', side: 'buy', price: '100', delta_size: '-0.4', remaining_size: '0.6' }));
    expect(r.ok).toBe(true);
    expect(b.positionOf('b1')!.index).toBe(0);
    expect(b.positionOf('b1')!.size.toString()).toBe('0.6');
    expect(b.level('buy', '100')!.total.toString()).toBe('2.6');
  });

  it('partial_fill reduces in place and reports position before', () => {
    const b = book();
    const r = b.apply(up({ action: 'partial_fill', order_id: 'b1', taker_order_id: 't', trade_id: 7, side: 'buy', price: '100', delta_size: '-0.25', remaining_size: '0.75' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.before!.index).toBe(0);
    expect(r.before!.atBestPrice).toBe(true);
    expect(r.reduced!.toString()).toBe('0.25');
    expect(r.removed).toBe(false);
    expect(b.positionOf('b1')!.size.toString()).toBe('0.75');
  });

  it('full_fill removes the order and empty levels', () => {
    const b = book();
    const r = b.apply(up({ action: 'full_fill', order_id: 'a1', side: 'sell', price: '101', delta_size: '-1.5', remaining_size: '0' }));
    expect(r.ok).toBe(true);
    expect(b.hasOrder('a1')).toBe(false);
    expect(b.level('sell', '101')).toBeUndefined();
    expect(b.bestAsk()!.key).toBe('102');
  });

  it('cancel removes from the middle of the queue', () => {
    const b = book();
    b.apply(up({ action: 'open', order_id: 'b4', side: 'buy', price: '100', delta_size: '1', remaining_size: '1' }));
    const r = b.apply(up({ action: 'cancel', order_id: 'b2', side: 'buy', price: '100', delta_size: '-2', remaining_size: '0' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.before!.index).toBe(1);
    expect(b.level('buy', '100')!.orders.map((o) => o.id)).toEqual(['b1', 'b4']);
    expect(b.positionOf('b4')!.index).toBe(1);
  });

  it('clear drops the book', () => {
    const b = book();
    const r = b.apply(up({ action: 'clear' }));
    expect(r.ok).toBe(true);
    expect(b.orderCount()).toBe(0);
    expect(b.bestBid()).toBeUndefined();
  });

  it('rejects inconsistent updates without throwing', () => {
    const b = book();
    const cases: Partial<L3Update>[] = [
      { action: 'open', order_id: 'b1', side: 'buy', price: '100', delta_size: '1', remaining_size: '1' }, // duplicate
      { action: 'cancel', order_id: 'zz', side: 'buy', price: '100', delta_size: '-1', remaining_size: '0' }, // unknown
      { action: 'modify', order_id: 'b1', side: 'buy', price: '100', delta_size: '-0.4', remaining_size: '0.5' }, // bad math
      { action: 'modify', order_id: 'b1', side: 'sell', price: '100', delta_size: '-0.4', remaining_size: '0.6' }, // wrong side
      { action: 'full_fill', order_id: 'b1', side: 'buy', price: '100', delta_size: '-0.5', remaining_size: '0.5' }, // not to zero
      { action: 'open', order_id: 'n', side: 'buy', price: 'abc', delta_size: '1', remaining_size: '1' }, // garbage
      { action: 'open', order_id: 'n2', side: 'buy' }, // missing fields
    ];
    for (const c of cases) {
      const r = b.apply(up(c));
      expect(r.ok, JSON.stringify(c)).toBe(false);
    }
    // Nothing changed.
    expect(b.level('buy', '100')!.total.toString()).toBe('3');
    expect(b.orderCount()).toBe(5);
  });

  it('computes size ahead including better prices', () => {
    const b = book();
    const p = b.positionOf('b3')!;
    expect(p.sizeAheadInLevel.toString()).toBe('0');
    expect(p.sizeAtBetterPrices.toString()).toBe('3');
    expect(p.atBestPrice).toBe(false);
    expect(b.sizeBetterThan('sell', '102').toString()).toBe('1.5');
  });

  it('depth returns best-first levels', () => {
    const b = book();
    const d = b.depth(1);
    expect(d.bids.map((l) => l.key)).toEqual(['100']);
    expect(d.asks.map((l) => l.key)).toEqual(['101']);
    expect(b.toJSON(1).bids[0]!.orders).toEqual([{ id: 'b1', size: '1' }, { id: 'b2', size: '2' }]);
  });
});
