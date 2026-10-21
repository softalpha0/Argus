import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { L3Client, type SocketLike } from '../src/strike/l3Client.js';
import type { L3Snapshot, L3Update } from '../src/book/OrderBook.js';
import { Backoff } from '../src/strike/backoff.js';

class FakeSocket implements SocketLike {
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  sent: string[] = [];
  closed = false;
  on(event: string, cb: (...a: any[]) => void) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  removeAllListeners() {
    this.handlers = {};
    return this;
  }
  fire(event: string, ...args: any[]) {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
  msg(o: unknown) {
    this.fire('message', Buffer.from(JSON.stringify(o)));
  }
}

const snapshot = (seq: number): L3Snapshot => ({
  type: 'l3_snapshot',
  symbol: 'BTC-USD',
  last_sequence: seq,
  timestamp: 1,
  bids: [{ price: '100', orders: [{ order_id: 'b1', size: '1' }] }],
  asks: [{ price: '101', orders: [{ order_id: 'a1', size: '1' }] }],
});

const open = (seq: number, id: string): L3Update => ({
  type: 'l3_update',
  symbol: 'BTC-USD',
  action: 'open',
  order_id: id,
  side: 'buy',
  price: '99',
  delta_size: '1',
  remaining_size: '1',
  sequence: seq,
  timestamp: 2,
});

describe('L3Client', () => {
  let sockets: FakeSocket[];
  let snapSeq: number;
  let client: L3Client;
  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sockets = [];
    snapSeq = 10;
    client = new L3Client({
      symbol: 'BTC-USD',
      wsUrl: 'wss://x',
      restUrl: 'https://x',
      logger: pino({ level: 'silent' }),
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      fetchSnapshot: async () => snapshot(snapSeq),
      backoff: new Backoff(1000, 30_000),
    });
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  async function bootstrap(buffered: L3Update[] = []) {
    client.start();
    const s = sockets.at(-1)!;
    s.fire('open');
    expect(JSON.parse(s.sent[0]!)).toEqual({ method: 'SUBSCRIBE', params: ['btc-usd@l3'], id: 1 });
    for (const u of buffered) s.msg(u);
    s.msg({ result: null, id: 1 });
    await flush();
    return s;
  }

  it('buffers before the ack, drops stale, replays the rest and goes live', async () => {
    await bootstrap([open(9, 'x9'), open(10, 'x10'), open(11, 'x11'), open(12, 'x12')]);
    expect(client.state).toBe('live');
    expect(client.book.lastSequence).toBe(12);
    expect(client.book.hasOrder('x9')).toBe(false);
    expect(client.book.hasOrder('x10')).toBe(false);
    expect(client.book.hasOrder('x11')).toBe(true);
    expect(client.book.hasOrder('x12')).toBe(true);
  });

  it('applies live updates in sequence', async () => {
    const s = await bootstrap();
    s.msg(open(11, 'n1'));
    s.msg(open(12, 'n2'));
    expect(client.book.lastSequence).toBe(12);
    expect(client.stats.updatesApplied).toBe(2);
  });

  it('resyncs on a gap and never applies past it', async () => {
    const s = await bootstrap();
    const desync = vi.fn();
    client.on('desync', desync);
    s.msg(open(12, 'skip'));
    expect(client.state).toBe('waiting');
    expect(client.book.hasOrder('skip')).toBe(false);
    expect(desync).toHaveBeenCalledWith({ reason: 'gap: expected 11, got 12' });
    // Reconnects after backoff and rebuilds from a new snapshot.
    snapSeq = 20;
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(2);
    const s2 = sockets[1]!;
    s2.fire('open');
    s2.msg({ result: null, id: 1 });
    await flush();
    expect(client.state).toBe('live');
    expect(client.book.lastSequence).toBe(20);
  });

  it('resyncs on a gap between snapshot and buffer', async () => {
    await bootstrap([open(13, 'late')]);
    expect(client.state).toBe('waiting');
    expect(client.stats.lastResyncReason).toMatch(/gap after snapshot/);
  });

  it('resyncs on clear, error messages, bad apply and close', async () => {
    const s = await bootstrap();
    s.msg({ type: 'l3_update', symbol: 'BTC-USD', action: 'clear', sequence: 11, timestamp: 3 });
    expect(client.stats.lastResyncReason).toBe('clear received');

    vi.advanceTimersByTime(30_000);
    let cur = sockets.at(-1)!;
    cur.fire('open');
    cur.msg({ error: { code: 400, msg: 'bad' }, id: 1 });
    expect(client.stats.lastResyncReason).toBe('server error 400 bad');

    vi.advanceTimersByTime(30_000);
    cur = sockets.at(-1)!;
    cur.fire('open');
    cur.msg({ result: null, id: 1 });
    await flush();
    cur.msg({ ...open(11, 'b1') }); // duplicate id -> apply failure
    expect(client.stats.lastResyncReason).toMatch(/apply failed at 11: duplicate order id b1/);

    vi.advanceTimersByTime(30_000);
    cur = sockets.at(-1)!;
    cur.fire('close', 1012, Buffer.from(''));
    expect(client.stats.lastResyncReason).toBe('socket closed (1012)');
    expect(client.stats.resyncs).toBe(4);
  });

  it('ignores events from abandoned sockets', async () => {
    const s = await bootstrap();
    s.msg(open(12, 'gap'));
    s.msg(open(11, 'late')); // old socket, already dropped
    expect(client.book.hasOrder('late')).toBe(false);
  });

  it('backs off exponentially up to 30 s', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const b = new Backoff(1000, 30_000);
    const delays = Array.from({ length: 7 }, () => b.next());
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
