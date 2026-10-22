import { afterEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import pino from 'pino';
import { OrderBook, type L3Update } from '../src/book/OrderBook.js';
import { MarketModel } from '../src/model/MarketModel.js';
import { PaperVenue } from '../src/engine/PaperVenue.js';
import { Execution, type ExecutionParams } from '../src/engine/Execution.js';
import { parseSymbolRules } from '../src/strike/exchangeInfo.js';

const rules = parseSymbolRules(
  {
    symbols: [{ symbol: 'BTC-USD', status: 'trading', filters: [
      { filterType: 'PRICE_FILTER', maxPrice: '1000000', minPrice: '10', tickSize: '1' },
      { filterType: 'LOT_SIZE', maxQty: '1000', minQty: '0.00001', stepSize: '0.00001' },
      { filterType: 'MIN_NOTIONAL', notional: '10' },
    ] }],
  },
  'BTC-USD',
);

const flush = () => new Promise((r) => setImmediate(r));
let clock = 0;
let seq = 0;
let execs: Execution[] = [];
afterEach(() => execs.forEach((e) => void e.cancel()));

function setup(params: Partial<ExecutionParams> = {}) {
  clock = 1_000_000;
  seq = 0;
  const book = new OrderBook();
  book.loadSnapshot({
    type: 'l3_snapshot', symbol: 'BTC-USD', last_sequence: 0, timestamp: clock,
    bids: [{ price: '100000', orders: [{ order_id: 'b1', size: '0.01' }] }],
    asks: [{ price: '100001', orders: [{ order_id: 'a1', size: '0.5' }] }, { price: '100003', orders: [{ order_id: 'a2', size: '1' }] }],
  });
  const model = new MarketModel(book);
  model.markStart(clock);
  const venue = new PaperVenue(book, { makerFee: '-0.00005', takerFee: '0.0005', now: () => clock });
  const exec = new Execution({
    id: 't1', owner: null, venue, book, model, rules, argusFeeBps: 2, takerFee: new Decimal('0.0005'),
    logger: pino({ level: 'silent' }), now: () => clock, tickMs: 1e9, minActionGapMs: 0,
    params: { mode: 'paper', side: 'buy', size: new Decimal('0.002'), deadlineSec: 60, maxSlippageBps: 10, preset: 'balanced', fallback: 'market', ...params },
  });
  execs.push(exec);
  const send = (p: Partial<L3Update>) => {
    const u = { type: 'l3_update', symbol: 'BTC-USD', sequence: ++seq, timestamp: clock, ...p } as L3Update;
    const res = book.apply(u);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    model.onUpdate(u, res);
    venue.onUpdate(u, res);
  };
  return { book, model, venue, exec, send };
}

describe('Execution (paper)', () => {
  it('works a buy as maker and reports savings', async () => {
    const { exec, send } = setup();
    exec.start();
    await flush(); // start() runs the first step
    // No fill history: queue estimate is infinite, spread is 1 tick, so it joins the best bid.
    expect(exec.working!.price.toString()).toBe('100000');
    expect(exec.toJSON().working!.queue!.place).toBe(2);
    // Sellers trade through b1, then into an order behind us.
    clock += 5000;
    send({ action: 'full_fill', order_id: 'b1', side: 'buy', price: '100000', delta_size: '-0.01', remaining_size: '0', trade_id: 1 });
    send({ action: 'open', order_id: 'b2', side: 'buy', price: '100000', delta_size: '0.01', remaining_size: '0.01' });
    expect(exec.filled.toString()).toBe('0');
    send({ action: 'partial_fill', order_id: 'b2', side: 'buy', price: '100000', delta_size: '-0.005', remaining_size: '0.005', trade_id: 2 });
    await new Promise((r) => setImmediate(r));
    expect(exec.state).toBe('done');
    const r = exec.report!;
    expect(r.filledSize).toBe('0.002');
    expect(r.makerShare).toBe('1');
    // Market buy would have paid 100001 + taker fee; we bought at 100000 with a rebate.
    expect(new Decimal(r.savings!).gt(0)).toBe(true);
    expect(exec.fills[0]!.tradeId).toBe(2);
  });

  it('reprices when the best bid moves up, and finishes with a market order at the deadline', async () => {
    const { exec, send } = setup();
    exec.start();
    await flush(); // start() runs the first step
    expect(exec.working!.price.toString()).toBe('100000');
    clock += 3000;
    send({ action: 'open', order_id: 'b9', side: 'buy', price: '100002', delta_size: '0.01', remaining_size: '0.01' });
    send({ action: 'open', order_id: 'a9', side: 'sell', price: '100004', delta_size: '0.01', remaining_size: '0.01' });
    send({ action: 'cancel', order_id: 'a1', side: 'sell', price: '100001', delta_size: '-0.5', remaining_size: '0' });
    send({ action: 'cancel', order_id: 'a2', side: 'sell', price: '100003', delta_size: '-1', remaining_size: '0' });
    await exec.step();
    // Spread now 2 ticks; queue estimate is Infinity, so it improves to 100003.
    expect(exec.working!.price.toString()).toBe('100003');
    expect(exec.events.some((e) => e.text.includes('price moved away'))).toBe(true);
    clock += 60_000;
    await exec.step();
    expect(exec.state).toBe('done');
    expect(exec.fills.map((f) => [f.price, f.isMaker])).toEqual([['100004', false]]);
    expect(exec.report!.makerShare).toBe('0');
  });

  it('cancels at the deadline when fallback is cancel', async () => {
    const { exec } = setup({ fallback: 'cancel' });
    exec.start();
    await flush(); // start() runs the first step
    clock += 61_000;
    await exec.step();
    expect(exec.state).toBe('done');
    expect(exec.fills).toHaveLength(0);
    expect(exec.report!.notes[0]).toMatch(/Nothing filled/);
  });

  it('cancels at the deadline instead of waiting when the order book is offline', async () => {
    let live = true;
    const { exec } = setup();
    (exec as any).d.bookLive = () => live;
    exec.start();
    await flush();
    expect(exec.working).not.toBeNull();
    live = false;
    clock += 30_000;
    await exec.step();
    expect(exec.state).toBe('working'); // before the deadline it just waits
    clock += 31_000;
    await exec.step();
    expect(exec.state).toBe('done');
    expect(exec.working).toBeNull();
    expect(exec.fills).toHaveLength(0);
    expect(exec.events.at(-1)!.text).toMatch(/order book was offline/);
  });

  it('rejects orders below the minimum and can be stopped', async () => {
    const { exec } = setup({ size: new Decimal('0.00005') });
    expect(() => exec.start()).toThrow(/below Strike's minimum/);
    const { exec: e2 } = setup();
    e2.start();
    await flush();
    await e2.cancel();
    expect(e2.state).toBe('canceled');
    expect(e2.working).toBeNull();
  });
});
