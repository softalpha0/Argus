import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import pino from 'pino';
import { OrderBook, type ApplyResult, type L3Update } from '../src/book/OrderBook.js';
import { LiveVenue } from '../src/engine/LiveVenue.js';
import { PostOnlyRejected, type Fill } from '../src/engine/Venue.js';
import type { OrderTradeUpdate } from '../src/strike/userStream.js';

const D = (v: string) => new Decimal(v);

function setup() {
  const book = new OrderBook();
  book.loadSnapshot({
    type: 'l3_snapshot', symbol: 'BTC-USD', last_sequence: 0, timestamp: 0,
    bids: [{ price: '100', orders: [{ order_id: 'x1', size: '1' }] }],
    asks: [{ price: '102', orders: [{ order_id: 'a1', size: '1' }] }],
  });
  const l3 = new EventEmitter() as EventEmitter & { book: OrderBook };
  l3.book = book;
  const stream = new EventEmitter();
  const calls: { fn: string; args: unknown[] }[] = [];
  let nextId = 500;
  const behaviour: { onCreate?: (body: any) => void; createError?: Error } = {};
  const rest = {
    createOrder: async (body: any, fee: number) => {
      calls.push({ fn: 'create', args: [body, fee] });
      if (behaviour.createError) throw behaviour.createError;
      setImmediate(() => behaviour.onCreate?.(body));
      return { client_order_id: body.client_order_id };
    },
    replaceOrder: async (cancel: any, body: any, fee: number) => {
      calls.push({ fn: 'replace', args: [cancel, body, fee] });
      setImmediate(() => behaviour.onCreate?.(body));
      return {};
    },
    cancelOrder: async (id: number) => {
      calls.push({ fn: 'cancel', args: [id] });
      return {};
    },
    getOrderByClientId: async () => ({ ID: 1, Status: 'filled', Builder: { Code: 'argus', FeeBps: 2 } }),
  };
  const tape = { trades: [] as any[] };
  const venue = new LiveVenue({ symbol: 'BTC-USD', rest: rest as any, stream: stream as any, l3: l3 as any, tape: tape as any, argusFeeBps: 2, logger: pino({ level: 'silent' }), maxActionsPerSec: 100, ackTimeoutMs: 300 });
  let seq = 0;
  const l3send = (p: Partial<L3Update>) => {
    const u = { type: 'l3_update', symbol: 'BTC-USD', sequence: ++seq, timestamp: Date.now(), ...p } as L3Update;
    l3.emit('beforeUpdate', u, book);
    const res: ApplyResult = book.apply(u);
    l3.emit('update', u, res, book);
  };
  const ev = (p: Partial<OrderTradeUpdate>) => stream.emit('order', { s: 'BTC-USD', S: 'BUY', o: 'LIMIT', X: 'OPEN', i: 0, p: '0', q: '0', l: '0', L: '0', z: '0', n: '0', N: 'USDT', m: false, t: 0, T: Date.now(), ...p });
  const newId = () => ++nextId;
  return { book, venue, calls, behaviour, ev, l3send, tape, newId };
}

describe('LiveVenue', () => {
  it('places post-only with the builder fee, links to L3 and reports maker fills', async () => {
    const { venue, calls, behaviour, ev, l3send, tape } = setup();
    behaviour.onCreate = (b) => {
      ev({ c: b.client_order_id, x: 'NEW', X: 'OPEN', i: 777 });
      l3send({ action: 'open', order_id: 'pubX', side: 'buy', price: '100', delta_size: '0.002', remaining_size: '0.002' });
    };
    const fills: Fill[] = [];
    venue.on('fill', (f) => fills.push(f));
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.002'), clientId: 'argus-t-1' });
    expect(calls[0]).toMatchObject({ fn: 'create', args: [{ post_only: true, time_in_force: 'GTC', type: 'limit', price: '100', size: '0.002' }, 2] });
    expect(o.exchangeId).toBe(777);
    await new Promise((r) => setImmediate(r));
    expect(o.publicId).toBe('pubX');
    expect(venue.queuePosition(o)).toMatchObject({ place: 2, estimating: false });
    expect(venue.queuePosition(o).sizeAhead.toString()).toBe('1');

    // Our L3 entry trades at the front of the queue, then the stream reports the fill.
    l3send({ action: 'full_fill', order_id: 'x1', side: 'buy', price: '100', delta_size: '-1', remaining_size: '0', trade_id: 40 });
    l3send({ action: 'full_fill', order_id: 'pubX', side: 'buy', price: '100', delta_size: '-0.002', remaining_size: '0', trade_id: 41 });
    tape.trades.push({ id: 41, price: D('100'), size: D('0.002'), time: Date.now(), buyerMaker: true });
    ev({ c: 'argus-t-1', x: 'TRADE', X: 'FILLED', i: 777, l: '0.002', L: '100', z: '0.002', n: '-0.00001', m: true, t: 41 });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ isMaker: true, tradeId: 41 });
    expect(fills[0]!.fee.toString()).toBe('-0.00001');
    expect(o.done).toBe(true);
    await new Promise((r) => setTimeout(r, 3100));
    expect(fills[0]!.checks).toMatchObject({ bestPrice: 'pass', firstInLine: 'pass', onTape: 'pass', linked: true });
    expect(await venue.audit()).toMatchObject({ orders: [{ clientOrderId: 'argus-t-1', builder: { Code: 'argus', FeeBps: 2 } }] });
  }, 10_000);

  it('links through the book when the open event was missed', async () => {
    const { venue, behaviour, ev, book } = setup();
    // Our order lands in the book before we are tracking opens (e.g. event arrived late).
    behaviour.onCreate = (b) => ev({ c: b.client_order_id, x: 'NEW', i: 55 });
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.003'), clientId: 'bk1' });
    expect(venue.queuePosition(o).estimating).toBe(true);
    book.apply({ type: 'l3_update', symbol: 'BTC-USD', action: 'open', order_id: 'pubB', side: 'buy', price: '100', delta_size: '0.003', remaining_size: '0.003', sequence: 99, timestamp: Date.now() });
    const q = venue.queuePosition(o);
    expect(o.publicId).toBe('pubB');
    expect(q).toMatchObject({ place: 2, estimating: false });
  });

  it('turns a post-only cancel before NEW into PostOnlyRejected', async () => {
    const { venue, behaviour, ev } = setup();
    behaviour.onCreate = (b) => ev({ c: b.client_order_id, x: 'EXPIRED', X: 'EXPIRED', cr: 'post only would cross' });
    await expect(venue.place({ side: 'buy', price: D('102'), size: D('0.001'), clientId: 'c2' })).rejects.toBeInstanceOf(PostOnlyRejected);
  });

  it('maps a REST post-only error and passes other errors through', async () => {
    const { venue, behaviour } = setup();
    const { StrikeError } = await import('../src/strike/rest.js');
    behaviour.createError = new StrikeError(400, 'post_only order would immediately match');
    await expect(venue.place({ side: 'buy', price: D('102'), size: D('0.001'), clientId: 'c3' })).rejects.toBeInstanceOf(PostOnlyRejected);
    behaviour.createError = new StrikeError(400, 'insufficient margin');
    await expect(venue.place({ side: 'buy', price: D('100'), size: D('0.001'), clientId: 'c4' })).rejects.toMatchObject({ message: 'insufficient margin' });
  });

  it('cancels by exchange id and waits for the confirmation', async () => {
    const { venue, behaviour, ev, calls } = setup();
    behaviour.onCreate = (b) => ev({ c: b.client_order_id, x: 'NEW', i: 900 });
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.001'), clientId: 'c5' });
    const p = venue.cancel(o);
    setTimeout(() => ev({ c: 'c5', x: 'CANCELED', X: 'CANCELED', i: 900 }), 20);
    await p;
    expect(calls.at(-1)).toEqual({ fn: 'cancel', args: [900] });
    expect(o.done).toBe(true);
  });

  it('replaces atomically with the old exchange id', async () => {
    const { venue, behaviour, ev, calls } = setup();
    behaviour.onCreate = (b) => ev({ c: b.client_order_id, x: 'NEW', i: b.client_order_id === 'r1' ? 11 : 12 });
    const o = await venue.place({ side: 'buy', price: D('100'), size: D('0.001'), clientId: 'r1' });
    const n = await venue.replace(o, { side: 'buy', price: D('101'), size: D('0.001'), clientId: 'r2' });
    expect(calls.at(-1)).toMatchObject({ fn: 'replace', args: [{ order_id: 11, symbol: 'BTC-USD' }, { client_order_id: 'r2', price: '101', post_only: true }, 2] });
    expect(n.exchangeId).toBe(12);
  });

  it('crosses with a market order and collects taker fills', async () => {
    const { venue, behaviour, ev, calls } = setup();
    behaviour.onCreate = (b) => {
      ev({ c: b.client_order_id, x: 'TRADE', X: 'PARTIALLY_FILLED', l: '0.0005', L: '102', z: '0.0005', n: '0.0255', m: false, t: 1 });
      ev({ c: b.client_order_id, x: 'TRADE', X: 'FILLED', l: '0.0005', L: '103', z: '0.001', n: '0.0257', m: false, t: 2 });
    };
    const fills = await venue.cross({ side: 'buy', size: D('0.001'), slippage: D('0.001'), clientId: 'm1' });
    expect(calls[0]).toMatchObject({ fn: 'create', args: [{ type: 'market', slippage: '0.001', size: '0.001' }, 2] });
    expect(fills.map((f) => [f.price.toString(), f.isMaker])).toEqual([['102', false], ['103', false]]);
  });
});
