import { beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { OrderBook, type L3Update } from '../src/book/OrderBook.js';
import { PaperVenue } from '../src/engine/PaperVenue.js';
import { PostOnlyRejected, type Fill } from '../src/engine/Venue.js';

const D = (v: string) => new Decimal(v);
let seq: number;
let book: OrderBook;
let venue: PaperVenue;
let fills: Fill[];

function send(p: Partial<L3Update>) {
  const u = { type: 'l3_update', symbol: 'BTC-USD', sequence: ++seq, timestamp: 1000 + seq, ...p } as L3Update;
  const res = book.apply(u);
  expect(res.ok, JSON.stringify(res)).toBe(true);
  venue.onUpdate(u, res);
}
const fill = (id: string, side: 'buy' | 'sell', price: string, delta: string, remaining: string) =>
  send({ action: remaining === '0' ? 'full_fill' : 'partial_fill', order_id: id, side, price, delta_size: `-${delta}`, remaining_size: remaining, trade_id: seq + 1 });

beforeEach(() => {
  seq = 0;
  book = new OrderBook();
  book.loadSnapshot({
    type: 'l3_snapshot',
    symbol: 'BTC-USD',
    last_sequence: 0,
    timestamp: 0,
    bids: [
      { price: '100', orders: [{ order_id: 'b1', size: '1' }, { order_id: 'b2', size: '2' }] },
      { price: '99', orders: [{ order_id: 'b3', size: '5' }] },
    ],
    asks: [{ price: '102', orders: [{ order_id: 'a1', size: '1' }] }],
  });
  venue = new PaperVenue(book, { makerFee: '-0.00005', takerFee: '0.0005', now: () => 5000 });
  fills = [];
  venue.on('fill', (f) => fills.push(f));
});

describe('PaperVenue', () => {
  it('joins the back of the real queue', async () => {
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    const q = venue.queuePosition(o);
    expect(q.place).toBe(3);
    expect(q.sizeAhead.toString()).toBe('3');
  });

  it('does not fill until every order ahead is filled', async () => {
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    fill('b1', 'buy', '100', '1', '0');
    expect(fills).toHaveLength(0);
    fill('b2', 'buy', '100', '1.5', '0.5');
    expect(fills).toHaveLength(0);
    expect(venue.queuePosition(o).sizeAhead.toString()).toBe('0.5');
    fill('b2', 'buy', '100', '0.5', '0');
    expect(fills).toHaveLength(0);
    expect(venue.queuePosition(o).place).toBe(1);
  });

  it('fills when a trade reaches an order behind us', async () => {
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    send({ action: 'open', order_id: 'b4', side: 'buy', price: '100', delta_size: '1', remaining_size: '1' });
    fill('b1', 'buy', '100', '1', '0');
    fill('b2', 'buy', '100', '2', '0');
    expect(fills).toHaveLength(0);
    fill('b4', 'buy', '100', '0.3', '0.7');
    expect(fills.map((f) => f.size.toString())).toEqual(['0.3']);
    expect(fills[0]!.isMaker).toBe(true);
    expect(fills[0]!.price.toString()).toBe('100');
    expect(fills[0]!.fee.toString()).toBe('-0.0015');
    fill('b4', 'buy', '100', '0.7', '0');
    expect(fills.map((f) => f.size.toString())).toEqual(['0.3', '0.2']);
    expect(o.done).toBe(true);
  });

  it('moves up when orders ahead cancel or shrink, without filling', async () => {
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    send({ action: 'cancel', order_id: 'b1', side: 'buy', price: '100', delta_size: '-1', remaining_size: '0' });
    expect(venue.queuePosition(o).place).toBe(2);
    send({ action: 'modify', order_id: 'b2', side: 'buy', price: '100', delta_size: '-1.5', remaining_size: '0.5' });
    expect(venue.queuePosition(o).sizeAhead.toString()).toBe('0.5');
    send({ action: 'cancel', order_id: 'b2', side: 'buy', price: '100', delta_size: '-0.5', remaining_size: '0' });
    expect(venue.queuePosition(o)).toMatchObject({ place: 1 });
    expect(fills).toHaveLength(0);
  });

  it('ignores cancels of orders that joined behind us', async () => {
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    send({ action: 'open', order_id: 'b4', side: 'buy', price: '100', delta_size: '1', remaining_size: '1' });
    send({ action: 'cancel', order_id: 'b4', side: 'buy', price: '100', delta_size: '-1', remaining_size: '0' });
    expect(venue.queuePosition(o).place).toBe(3);
  });

  it('fills when a trade happens at a worse price on our side', async () => {
    await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    fill('b3', 'buy', '99', '2', '3');
    expect(fills.map((f) => f.size.toString())).toEqual(['0.5']);
  });

  it('does not count an opposite order resting at our price as a fill, but reports it crossed', async () => {
    const o = await venue.place({ side: 'buy', price: D('101'), size: D('0.5'), clientId: 'p1' });
    expect(venue.isCrossed(o)).toBe(false);
    send({ action: 'open', order_id: 'a2', side: 'sell', price: '101', delta_size: '0.2', remaining_size: '0.2' });
    expect(fills).toHaveLength(0);
    expect(venue.isCrossed(o)).toBe(true);
  });

  it('ignores trades at better prices', async () => {
    await venue.place({ side: 'buy', price: D('99'), size: D('0.5'), clientId: 'p1' });
    fill('b1', 'buy', '100', '1', '0');
    expect(fills).toHaveLength(0);
  });

  it('rejects post-only orders that would cross', async () => {
    await expect(venue.place({ side: 'buy', price: D('102'), size: D('1'), clientId: 'x' })).rejects.toBeInstanceOf(PostOnlyRejected);
    await expect(venue.place({ side: 'sell', price: D('100'), size: D('1'), clientId: 'y' })).rejects.toBeInstanceOf(PostOnlyRejected);
  });

  it('stops tracking after cancel', async () => {
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    await venue.cancel(o);
    fill('b3', 'buy', '99', '1', '4');
    expect(fills).toHaveLength(0);
  });

  it('crosses by walking the book with taker fees and a slippage cap', async () => {
    send({ action: 'open', order_id: 'a2', side: 'sell', price: '103', delta_size: '1', remaining_size: '1' });
    send({ action: 'open', order_id: 'a3', side: 'sell', price: '120', delta_size: '5', remaining_size: '5' });
    const f = await venue.cross({ side: 'buy', size: D('1.5'), slippage: D('0.02'), clientId: 'm' });
    expect(f.map((x) => [x.price.toString(), x.size.toString(), x.isMaker])).toEqual([
      ['102', '1', false],
      ['103', '0.5', false],
    ]);
    expect(f[0]!.fee.toString()).toBe('0.051');
    // Slippage cap stops before 120.
    const g = await venue.cross({ side: 'buy', size: D('10'), slippage: D('0.02'), clientId: 'm2' });
    expect(g.reduce((s, x) => s.plus(x.size), D('0')).toString()).toBe('2');
  });

  it('after a resync drops vanished orders ahead but does not invent fills', async () => {
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.5'), clientId: 'p1' });
    book.loadSnapshot({
      type: 'l3_snapshot', symbol: 'BTC-USD', last_sequence: 50, timestamp: 0,
      bids: [{ price: '100', orders: [{ order_id: 'b2', size: '1' }, { order_id: 'b9', size: '1' }] }],
      asks: [{ price: '102', orders: [{ order_id: 'a1', size: '1' }] }],
    });
    venue.onResync();
    expect(venue.queuePosition(o)).toMatchObject({ place: 2 });
    expect(venue.queuePosition(o).sizeAhead.toString()).toBe('1');
    expect(fills).toHaveLength(0);
  });
});
