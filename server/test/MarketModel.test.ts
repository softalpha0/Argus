import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { OrderBook, type L3Update } from '../src/book/OrderBook.js';
import { MarketModel } from '../src/model/MarketModel.js';

function setup() {
  const book = new OrderBook();
  book.loadSnapshot({
    type: 'l3_snapshot', symbol: 'BTC-USD', last_sequence: 0, timestamp: 0,
    bids: [
      { price: '100', orders: [{ order_id: 'b1', size: '10' }, { order_id: 'b2', size: '2' }] },
      { price: '99', orders: [{ order_id: 'b3', size: '5' }] },
    ],
    asks: [{ price: '101', orders: [{ order_id: 'a1', size: '100' }] }],
  });
  const model = new MarketModel(book, { tauMs: 180_000 });
  let seq = 0;
  const send = (p: Partial<L3Update>) => {
    const u = { type: 'l3_update', symbol: 'BTC-USD', sequence: ++seq, ...p } as L3Update;
    model.onUpdate(u, book.apply(u));
  };
  return { book, model, send };
}

describe('MarketModel', () => {
  it('reports queue ahead and size ahead of an order', () => {
    const { model } = setup();
    expect(model.queueAhead('buy', '100').toString()).toBe('12');
    expect(model.queueAhead('buy', '98').toString()).toBe('0');
    expect(model.sizeAheadAt('buy', '99').toString()).toBe('17');
    expect(model.sizeAheadOf('b2')!.toString()).toBe('10');
    expect(model.sizeAheadOf('b3')!.toString()).toBe('12');
  });

  it('estimates a steady fill rate per side', () => {
    const { model, send } = setup();
    model.markStart(0);
    // 0.01 BTC every second on resting sell orders for 10 minutes.
    let remaining = new Decimal(100);
    for (let t = 1000; t <= 600_000; t += 1000) {
      remaining = remaining.minus('0.01');
      send({ action: 'partial_fill', order_id: 'a1', side: 'sell', price: '101', delta_size: '-0.01', remaining_size: remaining.toString(), timestamp: t, trade_id: t });
    }
    expect(model.fillRate('sell', 600_000)).toBeCloseTo(0.01, 3);
    expect(model.fillRate('buy', 600_000)).toBe(0);
    // Decays after activity stops.
    expect(model.fillRate('sell', 600_000 + 180_000)).toBeCloseTo(0.01 / Math.E, 3);
  });

  it('is not inflated by a short history', () => {
    const { model, send } = setup();
    model.markStart(0);
    for (let t = 1000; t <= 10_000; t += 1000) {
      send({ action: 'partial_fill', order_id: 'a1', side: 'sell', price: '101', delta_size: '-0.01', remaining_size: new Decimal(100).minus(new Decimal('0.01').mul(t / 1000)).toString(), timestamp: t, trade_id: t });
    }
    expect(model.fillRate('sell', 10_000)).toBeCloseTo(0.01, 3);
  });

  it('expected fill time uses queue ahead plus our size, Infinity with no flow', () => {
    const { model, send } = setup();
    model.markStart(0);
    expect(model.expectedFillSeconds('buy', '100', '1', 1000)).toBe(Infinity);
    let rem = new Decimal(10);
    for (let t = 1000; t <= 600_000; t += 1000) {
      rem = rem.minus('0.001');
      send({ action: 'partial_fill', order_id: 'b1', side: 'buy', price: '100', delta_size: '-0.001', remaining_size: rem.toString(), timestamp: t, trade_id: t });
    }
    // ~0.001 BTC/s; ahead = what is left at 100 (rem + 2), plus our 1.
    const est = model.expectedFillSeconds('buy', '100', '1', 600_000);
    const expected = rem.plus(3).toNumber() / 0.001;
    expect(est / expected).toBeCloseTo(1, 1);
    expect(model.fillsByLevel('buy', 600_000).get('100')!.toNumber()).toBeCloseTo(0.301, 6) // window is inclusive: 301 fills;
  });
});
