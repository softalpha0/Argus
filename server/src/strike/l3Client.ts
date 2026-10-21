import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from 'pino';
import { OrderBook, type ApplyResult, type L3Snapshot, type L3Update } from '../book/OrderBook.js';
import { Backoff } from './backoff.js';

/** Minimal socket surface so tests can inject a fake. */
export interface SocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
  removeAllListeners(): unknown;
}

export type L3State = 'idle' | 'connecting' | 'subscribing' | 'snapshot' | 'live' | 'waiting' | 'stopped';

export interface L3ClientOptions {
  symbol: string;
  wsUrl: string;
  restUrl: string;
  logger: Logger;
  connect?: (url: string) => SocketLike;
  fetchSnapshot?: (url: string) => Promise<L3Snapshot>;
  backoff?: Backoff;
}

export interface L3Stats {
  state: L3State;
  lastSequence: number;
  updatesApplied: number;
  syncs: number;
  resyncs: number;
  resyncReasons: Record<string, number>;
  lastResyncReason: string | null;
  liveSince: number | null;
  lastMessageAt: number | null;
}

export interface L3ClientEvents {
  /** Book loaded from a snapshot and caught up with buffered updates. */
  synced: [{ sequence: number; book: OrderBook }];
  /** Fires before the update is applied, so listeners see the book as it was. */
  beforeUpdate: [L3Update, OrderBook];
  update: [L3Update, ApplyResult, OrderBook];
  /** Book is no longer trustworthy; it will be rebuilt. */
  desync: [{ reason: string }];
  state: [L3State];
}

async function defaultFetchSnapshot(url: string): Promise<L3Snapshot> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const body = (await res.json()) as L3Snapshot;
  if (body?.type !== 'l3_snapshot' || typeof body.last_sequence !== 'number') throw new Error('snapshot: unexpected body');
  return body;
}

const SUB_ID = 1;

/**
 * Keeps a local L3 book in sync with Strike.
 *
 * Bootstrap: open socket, SUBSCRIBE, buffer every update, after the ack fetch the
 * snapshot, drop buffered seq <= last_sequence, apply the rest with strict +1
 * continuity, then go live. Any gap, clear, error or close tears it down and
 * starts over with backoff. It never guesses through a gap.
 */
export class L3Client extends EventEmitter<L3ClientEvents> {
  readonly book: OrderBook;
  private ws: SocketLike | null = null;
  private buffer: L3Update[] = [];
  private stateValue: L3State = 'idle';
  private backoff: Backoff;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private stopped = false;
  private readonly connectFn: (url: string) => SocketLike;
  private readonly fetchSnapshotFn: (url: string) => Promise<L3Snapshot>;
  readonly stats: L3Stats = {
    state: 'idle',
    lastSequence: 0,
    updatesApplied: 0,
    syncs: 0,
    resyncs: 0,
    resyncReasons: {},
    lastResyncReason: null,
    liveSince: null,
    lastMessageAt: null,
  };

  constructor(private readonly opts: L3ClientOptions) {
    super();
    this.book = new OrderBook(opts.symbol);
    this.backoff = opts.backoff ?? new Backoff(1000, 30_000);
    this.connectFn = opts.connect ?? ((url) => new WebSocket(url, { handshakeTimeout: 10_000 }) as unknown as SocketLike);
    this.fetchSnapshotFn = opts.fetchSnapshot ?? defaultFetchSnapshot;
  }

  get state(): L3State {
    return this.stateValue;
  }

  get isLive(): boolean {
    return this.stateValue === 'live';
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dropSocket();
    this.setState('stopped');
  }

  private setState(s: L3State): void {
    if (this.stateValue === s) return;
    this.stateValue = s;
    this.stats.state = s;
    this.stats.liveSince = s === 'live' ? Date.now() : this.stats.liveSince && s !== 'waiting' ? this.stats.liveSince : null;
    this.emit('state', s);
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners();
    ws.on('error', () => {}); // swallow late errors from a socket we abandoned
    try {
      if (ws.terminate) ws.terminate();
      else ws.close();
    } catch {
      /* already closed */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.buffer = [];
    this.setState('connecting');
    let ws: SocketLike;
    try {
      ws = this.connectFn(this.opts.wsUrl);
    } catch (err) {
      this.resync(`connect failed: ${(err as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (gen !== this.generation) return;
      this.setState('subscribing');
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${this.opts.symbol.toLowerCase()}@l3`], id: SUB_ID }));
    });
    ws.on('message', (data) => {
      if (gen !== this.generation) return;
      this.onMessage(data.toString(), gen);
    });
    ws.on('close', (code) => {
      if (gen !== this.generation) return;
      // 1012/1013/1001 are planned restarts; everything else is also a reconnect, just logged louder.
      this.resync(`socket closed (${code})`, code === 1001 || code === 1012 || code === 1013);
    });
    ws.on('error', (err) => {
      if (gen !== this.generation) return;
      this.resync(`socket error: ${err.message}`);
    });
  }

  private onMessage(text: string, gen: number): void {
    this.stats.lastMessageAt = Date.now();
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.resync('unparseable message');
      return;
    }
    const m = msg as Record<string, unknown>;
    if (m.error) {
      const e = m.error as { code?: number; msg?: string };
      this.resync(`server error ${e.code ?? ''} ${e.msg ?? ''}`.trim());
      return;
    }
    if (m.type === 'l3_update') {
      const u = m as unknown as L3Update;
      if (typeof u.sequence !== 'number') {
        this.resync('update without sequence');
        return;
      }
      if (this.stateValue === 'live') this.applyLive(u);
      else this.buffer.push(u);
      return;
    }
    if (m.id === SUB_ID && 'result' in m) {
      if (this.stateValue === 'subscribing') void this.loadSnapshot(gen);
      return;
    }
    this.opts.logger.debug({ msg: m }, 'l3: ignoring message');
  }

  private async loadSnapshot(gen: number): Promise<void> {
    this.setState('snapshot');
    let snap: L3Snapshot;
    try {
      snap = await this.fetchSnapshotFn(`${this.opts.restUrl}/v2/l3/snapshot?symbol=${encodeURIComponent(this.opts.symbol)}`);
    } catch (err) {
      if (gen === this.generation) this.resync(`snapshot failed: ${(err as Error).message}`);
      return;
    }
    if (gen !== this.generation) return;
    try {
      this.book.loadSnapshot(snap);
    } catch (err) {
      this.resync(`snapshot load failed: ${(err as Error).message}`);
      return;
    }
    let last = snap.last_sequence;
    const pending = this.buffer.filter((u) => u.sequence > last);
    this.buffer = [];
    for (const u of pending) {
      if (u.sequence !== last + 1) {
        this.resync(`gap after snapshot: expected ${last + 1}, got ${u.sequence}`);
        return;
      }
      if (!this.applyOne(u)) return;
      last = u.sequence;
    }
    this.stats.syncs++;
    this.stats.lastSequence = this.book.lastSequence;
    this.setState('live');
    this.backoff.reset();
    this.opts.logger.info({ sequence: this.book.lastSequence, orders: this.book.orderCount(), replayed: pending.length }, 'l3: book synced');
    this.emit('synced', { sequence: this.book.lastSequence, book: this.book });
  }

  private applyLive(u: L3Update): void {
    const expected = this.book.lastSequence + 1;
    if (u.sequence !== expected) {
      this.resync(`gap: expected ${expected}, got ${u.sequence}`);
      return;
    }
    this.applyOne(u);
  }

  /** Returns false if it triggered a resync. */
  private applyOne(u: L3Update): boolean {
    if (u.action === 'clear') {
      this.resync('clear received');
      return false;
    }
    this.emit('beforeUpdate', u, this.book);
    const res = this.book.apply(u);
    if (!res.ok) {
      this.resync(`apply failed at ${u.sequence}: ${res.error}`);
      return false;
    }
    this.stats.updatesApplied++;
    this.stats.lastSequence = u.sequence;
    this.emit('update', u, res, this.book);
    return true;
  }

  private resync(reason: string, quiet = false): void {
    if (this.stopped) return;
    const key = reason.replace(/[0-9]+/g, 'N');
    this.stats.resyncs++;
    this.stats.resyncReasons[key] = (this.stats.resyncReasons[key] ?? 0) + 1;
    this.stats.lastResyncReason = reason;
    const log = quiet ? this.opts.logger.info.bind(this.opts.logger) : this.opts.logger.warn.bind(this.opts.logger);
    const delay = this.backoff.next();
    log({ reason, retryMs: delay }, 'l3: resyncing');
    const wasLive = this.stateValue === 'live';
    this.generation++;
    this.dropSocket();
    this.buffer = [];
    this.setState('waiting');
    if (wasLive) this.emit('desync', { reason });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
