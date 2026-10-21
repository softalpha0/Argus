import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from 'pino';
import { Decimal } from 'decimal.js';
import { Backoff } from './backoff.js';
import type { SocketLike } from './l3Client.js';

export interface TapeTrade {
  id: number;
  price: Decimal;
  size: Decimal;
  time: number;
  /** True means the buyer was the maker, i.e. a seller took liquidity. */
  buyerMaker: boolean;
}

export interface TapeClientOptions {
  symbol: string;
  wsUrl: string;
  logger: Logger;
  connect?: (url: string) => SocketLike;
  /** How long to keep trades for tape matching. */
  retainMs?: number;
}

export interface TapeEvents {
  trade: [TapeTrade];
  connected: [];
}

export function parseTrade(m: Record<string, unknown>): TapeTrade | null {
  if (m.e !== 'trade') return null;
  if (typeof m.p !== 'string' || typeof m.q !== 'string' || typeof m.t !== 'number') return null;
  return {
    id: m.t,
    price: new Decimal(m.p),
    size: new Decimal(m.q),
    time: typeof m.T === 'number' ? m.T : Date.now(),
    buyerMaker: m.m === true,
  };
}

/** Public trade tape from the price websocket. */
export class TapeClient extends EventEmitter<TapeEvents> {
  private ws: SocketLike | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoff = new Backoff(1000, 30_000);
  private stopped = false;
  private gen = 0;
  private recentTrades: TapeTrade[] = [];
  private readonly retainMs: number;
  private readonly connectFn: (url: string) => SocketLike;
  connected = false;
  reconnects = 0;
  tradesSeen = 0;

  constructor(private readonly opts: TapeClientOptions) {
    super();
    this.retainMs = opts.retainMs ?? 10 * 60_000;
    this.connectFn = opts.connect ?? ((url) => new WebSocket(url, { handshakeTimeout: 10_000 }) as unknown as SocketLike);
  }

  get trades(): readonly TapeTrade[] {
    return this.recentTrades;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    this.teardown();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** Trades within `windowMs` of `time` at exactly this price and size. */
  findMatch(price: Decimal.Value, size: Decimal.Value, time: number, windowMs = 5000): TapeTrade | undefined {
    const p = new Decimal(price);
    const s = new Decimal(size);
    return this.recentTrades.find((t) => Math.abs(t.time - time) <= windowMs && t.price.eq(p) && t.size.eq(s));
  }

  private teardown(): void {
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        if (ws.terminate) ws.terminate();
        else ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.gen;
    let ws: SocketLike;
    try {
      ws = this.connectFn(this.opts.wsUrl);
    } catch (err) {
      this.retry(`connect failed: ${(err as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (gen !== this.gen) return;
      ws.send(JSON.stringify({ method: 'subscribe', channel: 'trade', symbol: this.opts.symbol, id: 1 }));
      this.pingTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ method: 'ping', id: 99 }));
        } catch {
          /* close handler will reconnect */
        }
      }, 30_000);
      this.connected = true;
      this.backoff.reset();
      this.emit('connected');
    });
    ws.on('message', (data) => {
      if (gen !== this.gen) return;
      // Be tolerant of newline-batched frames.
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          this.opts.logger.warn('tape: unparseable message');
          continue;
        }
        const t = parseTrade(m);
        if (t) this.onTrade(t);
        else if (m.error) this.opts.logger.warn({ error: m.error }, 'tape: server error');
      }
    });
    ws.on('close', (code) => {
      if (gen === this.gen) this.retry(`closed (${code})`);
    });
    ws.on('error', (err) => {
      if (gen === this.gen) this.retry(`error: ${err.message}`);
    });
  }

  private onTrade(t: TapeTrade): void {
    this.tradesSeen++;
    this.recentTrades.push(t);
    const cutoff = Date.now() - this.retainMs;
    let drop = 0;
    while (drop < this.recentTrades.length && this.recentTrades[drop]!.time < cutoff) drop++;
    if (drop) this.recentTrades.splice(0, drop);
    this.emit('trade', t);
  }

  private retry(reason: string): void {
    if (this.stopped) return;
    this.reconnects++;
    this.gen++;
    this.teardown();
    const delay = this.backoff.next();
    this.opts.logger.warn({ reason, retryMs: delay }, 'tape: reconnecting');
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
