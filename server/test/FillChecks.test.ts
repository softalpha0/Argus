import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { OrderBook, type L3Update } from '../src/book/OrderBook.js';
import { FillChecks } from '../src/fairness/FillChecks.js';

describe('FillChecks', () => {
  const book = new OrderBook();
  book.loadSnapshot({
    type: 'l3_snapshot', symbol: 'BTC-USD', last_sequence: 0, timestamp: 0,
    bids: [{ price: '100', orders: [{ order_id: 'x', size: '1' }, { order_id: 'ours', size: '1' }] }],
    asks: [{ price: '101', orders: [{ order_id: 'a', size: '1' }] }],
  });
  const fill = (id: string, trade: number): L3Update => ({ type: 'l3_update', symbol: 'BTC-USD', action: 'partial_fill', order_id: id, side: 'buy', price: '100', delta_size: '-0.1', remaining_size: '0.9', sequence: 1, trade_id: trade, timestamp: 1000 });

  it('records position before the fill and matches the tape by trade id', () => {
    const c = new FillChecks();
    c.observe(fill('ours', 7), book, new Set(['ours']));
    c.observe(fill('x', 8), book, new Set(['ours'])); // not ours, ignored
    const r = c.evaluate({ tradeId: 7, price: new Decimal(100), size: new Decimal('0.1'), ts: 1000 }, true, [
      { id: 7, price: new Decimal(100), size: new Decimal('0.1'), time: 1000, buyerMaker: true },
    ]);
    expect(r).toMatchObject({ bestPrice: 'pass', firstInLine: 'fail', onTape: 'pass', linked: true });
  });

  it('reports unknown without an L3 link and fail without a tape match', () => {
    const c = new FillChecks();
    const r = c.evaluate({ tradeId: 9, price: new Decimal(100), size: new Decimal('0.1'), ts: 1000 }, false, []);
    expect(r).toMatchObject({ bestPrice: 'unknown', firstInLine: 'unknown', onTape: 'fail', linked: false });
    expect(r.note).toMatch(/not matched/);
  });
});
