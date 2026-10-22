import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from 'pino';
import { Backoff } from './backoff.js';
import { getClockSkew, signHex, type ApiWalletKey } from './rest.js';
import type { SocketLike } from './l3Client.js';

/** ORDER_TRADE_UPDATE data, Binance-style keys. */
export interface OrderTradeUpdate {
  s: string;
  c: string;
  S: string;
  o: string;
  x: 'NEW' | 'TRADE' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'CALCULATED' | string;
  X: string;
  i: number;
  p: string;
  q: string;
  l: string;
  L: string;
  z: string;
  n: string;
  N: string;
  m: boolean;
  t: number;
  T: number;
  cr?: string;
  /** Builder fee Strike charged on this fill, separately from the commission n. */
  builder_fee?: string;
  [k: string]: unknown;
}

interface UserStreamEvents {
  order: [OrderTradeUpdate];
  ready: [];
  down: [string];
}

/** Splits a frame that may hold several newline-separated JSON objects. */
export function splitFrames(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip a bad line, keep the rest */
    }
  }
  return out;
}

export function logonMessage(timestampMs: number, apiKey: string): string {
  return `session.logon:${timestampMs}:${apiKey}`;
}

/** One authenticated user data stream per connected user. */
export class UserStream extends EventEmitter<UserStreamEvents> {
  private ws: SocketLike | null = null;
  private ping: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private backoff = new Backoff(1000, 30_000);
  private gen = 0;
  private stopped = false;
  ready = false;

  constructor(
    private readonly url: string,
    private readonly key: ApiWalletKey,
    private readonly logger: Logger,
    private readonly connectFn: (url: string) => SocketLike = (u) => new WebSocket(u, { handshakeTimeout: 10_000 }) as unknown as SocketLike,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    if (this.retry) clearTimeout(this.retry);
    this.teardown();
  }

  /** Resolves once logged on and subscribed, or rejects after `timeoutMs`. */
  waitReady(timeoutMs = 10_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('ready', ok);
        reject(new Error('Could not connect to your Strike account stream'));
      }, timeoutMs);
      const ok = () => {
        clearTimeout(t);
        resolve();
      };
      this.once('ready', ok);
    });
  }

  private teardown(): void {
    this.ready = false;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners();
    ws.on('error', () => {});
    try {
      if (ws.terminate) ws.terminate();
      else ws.close();
    } catch {
      /* ignore */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.gen;
    let ws: SocketLike;
    try {
      ws = this.connectFn(this.url);
    } catch (err) {
      this.reconnect(`connect failed: ${(err as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (gen !== this.gen) return;
      // Logon allows at most 30 s in the future; correct for a fast local clock.
      const ts = Date.now() - Math.max(0, getClockSkew());
      void signHex(logonMessage(ts, this.key.publicKey), this.key.secretKey).then((signature) => {
        if (gen !== this.gen) return;
        ws.send(JSON.stringify({ method: 'session.logon', id: 1, params: { apiKey: this.key.publicKey, signature, timestamp: ts } }));
      });
    });
    ws.on('message', (data) => {
      if (gen !== this.gen) return;
      for (const m of splitFrames(data.toString()) as Record<string, unknown>[]) this.onMessage(m, ws);
    });
    ws.on('close', (code) => {
      if (gen === this.gen) this.reconnect(`closed (${code})`);
    });
    ws.on('error', (err) => {
      if (gen === this.gen) this.reconnect(`error: ${err.message}`);
    });
  }

  private onMessage(m: Record<string, unknown>, ws: SocketLike): void {
    if (m.id === 1) {
      const ok = m.status === 200 && (m.result as { authenticated?: boolean } | undefined)?.authenticated;
      if (!ok) {
        // Bad credentials won't fix themselves; stop and surface it.
        this.logger.warn({ status: m.status }, 'user stream: logon rejected');
        this.stop();
        this.emit('down', 'Strike rejected the API wallet logon');
        return;
      }
      ws.send(JSON.stringify({ method: 'subscribe', channel: 'userstream', id: 2 }));
      return;
    }
    if (m.id === 2) {
      if (m.status !== undefined && m.status !== 200) {
        this.reconnect(`subscribe failed (${String(m.status)})`);
        return;
      }
      this.ready = true;
      this.backoff.reset();
      this.ping = setInterval(() => {
        try {
          ws.send(JSON.stringify({ method: 'ping', id: 'hb' }));
        } catch {
          /* close handler reconnects */
        }
      }, 30_000);
      this.emit('ready');
      return;
    }
    if (m.e === 'ORDER_TRADE_UPDATE' && m.data) {
      this.emit('order', m.data as OrderTradeUpdate);
    }
  }

  private reconnect(reason: string): void {
    if (this.stopped) return;
    const wasReady = this.ready;
    this.gen++;
    this.teardown();
    if (wasReady) this.emit('down', reason);
    const delay = this.backoff.next();
    this.logger.warn({ reason, retryMs: delay }, 'user stream: reconnecting');
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), delay);
  }
}
