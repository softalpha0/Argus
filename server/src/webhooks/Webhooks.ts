import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { Logger } from 'pino';
import type { DocStore } from '../db/DocStore.js';

export interface WebhookRecord {
  id: string;
  owner: string;
  url: string;
  createdAt: number;
  /** Signing secret: AES-256-GCM sealed with the master key when one is set, else plain. */
  secret: { iv: string; tag: string; ciphertext: string } | { plain: string };
  disabledAt?: number;
  lastDelivery?: { at: number; eventId: string; ok: boolean; status: number | null; error: string | null; attempt: number };
}

export type PublicWebhook = Omit<WebhookRecord, 'secret' | 'owner'>;

export class WebhookError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MAX_PER_OWNER = 5;
const TIMEOUT_MS = 5000;
/** Delays before each retry after the first attempt. */
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

/** Loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

/** Stripe-style signature over "<unix seconds>.<body>". */
export function signPayload(secret: string, body: string, timestampSec: number): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${v1}`;
}

/** Receivers can use this (or the same few lines) to check a delivery. */
export function verifySignature(secret: string, body: string, header: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec || !parts.v1) return false;
  const expected = Buffer.from(signPayload(secret, body, t).split('v1=')[1]!, 'hex');
  const got = Buffer.from(parts.v1, 'hex');
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export interface WebhookOptions {
  /** Allow http:// and private addresses (local development and tests only). */
  allowInsecure?: boolean;
  masterKeyHex?: string | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  retryDelaysMs?: number[];
  resolve?: (host: string) => Promise<string[]>;
}

/** Webhook endpoints per wallet, and signed delivery of execution events with retries. */
export class Webhooks {
  private byId = new Map<string, WebhookRecord>();
  private readonly key: Buffer | null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly delays: number[];
  private readonly resolve: (host: string) => Promise<string[]>;
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly db: DocStore,
    private readonly collection: string,
    private readonly logger: Logger,
    private readonly opts: WebhookOptions = {},
  ) {
    this.key = opts.masterKeyHex ? Buffer.from(opts.masterKeyHex, 'hex') : null;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.resolve = opts.resolve ?? (async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address));
  }

  async init(): Promise<void> {
    this.byId = await this.db.loadAll<WebhookRecord>(this.collection);
  }

  private seal(secret: string, id: string): WebhookRecord['secret'] {
    if (!this.key) return { plain: secret };
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(id));
    const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
    return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ciphertext: ct.toString('hex') };
  }

  private unseal(w: WebhookRecord): string {
    if ('plain' in w.secret) return w.secret.plain;
    if (!this.key) throw new Error('Webhook secret is encrypted but no master key is set');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(w.secret.iv, 'hex'));
    d.setAAD(Buffer.from(w.id));
    d.setAuthTag(Buffer.from(w.secret.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(w.secret.ciphertext, 'hex')), d.final()]).toString('utf8');
  }

  /** Rejects URLs Argus must not call: non-HTTPS, credentials in the URL, or hosts on private networks. */
  async checkUrl(raw: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new WebhookError('url must be a valid URL');
    }
    if (u.protocol !== 'https:' && !(this.opts.allowInsecure && u.protocol === 'http:')) throw new WebhookError('url must use https');
    if (u.username || u.password) throw new WebhookError('url must not contain credentials');
    if (!this.opts.allowInsecure) {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      let addrs: string[];
      try {
        addrs = net.isIP(host) ? [host] : await this.resolve(host);
      } catch {
        throw new WebhookError(`Could not resolve ${u.hostname}`);
      }
      if (!addrs.length || addrs.some(isPrivateAddress)) throw new WebhookError('url must point to a public address');
    }
    return u;
  }

  async create(owner: string, rawUrl: unknown): Promise<{ secret: string; webhook: PublicWebhook }> {
    if (typeof rawUrl !== 'string' || rawUrl.length > 2000) throw new WebhookError('url is required');
    const u = await this.checkUrl(rawUrl);
    if (this.list(owner).filter((w) => !w.disabledAt).length >= MAX_PER_OWNER) throw new WebhookError(`You can have at most ${MAX_PER_OWNER} webhooks`);
    const id = `wh_${crypto.randomBytes(8).toString('hex')}`;
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const rec: WebhookRecord = { id, owner, url: u.toString(), createdAt: this.now(), secret: this.seal(secret, id) };
    this.byId.set(id, rec);
    await this.db.put(this.collection, id, rec);
    return { secret, webhook: Webhooks.toPublic(rec) };
  }

  static toPublic(w: WebhookRecord): PublicWebhook {
    const { secret: _s, owner: _o, ...rest } = w;
    return rest;
  }

  list(owner: string): PublicWebhook[] {
    return [...this.byId.values()].filter((w) => w.owner === owner).sort((a, b) => b.createdAt - a.createdAt).map(Webhooks.toPublic);
  }

  async remove(owner: string, id: string): Promise<boolean> {
    const w = this.byId.get(id);
    if (!w || w.owner !== owner) return false;
    this.byId.delete(id);
    await this.db.remove(this.collection, id);
    return true;
  }

  /** Sends an event to every active webhook of `owner`, retrying failures in the background. */
  emit(owner: string, type: string, data: unknown): string {
    const event = { id: `evt_${crypto.randomBytes(10).toString('hex')}`, type, createdAt: this.now(), data };
    for (const w of this.byId.values()) {
      if (w.owner === owner && !w.disabledAt) void this.deliver(w, event, 1);
    }
    return event.id;
  }

  private async deliver(w: WebhookRecord, event: { id: string; type: string }, attempt: number): Promise<void> {
    const body = JSON.stringify(event);
    let status: number | null = null;
    let error: string | null = null;
    try {
      // Re-check at send time so a DNS change can't point an approved host at a private address.
      await this.checkUrl(w.url);
      const res = await this.fetchFn(w.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Argus-Webhooks/1',
          'argus-event-id': event.id,
          'argus-event-type': event.type,
          'argus-signature': signPayload(this.unseal(w), body, Math.floor(this.now() / 1000)),
        },
        body,
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message;
    }
    const ok = error === null;
    if (this.byId.get(w.id) !== w) return; // removed meanwhile
    w.lastDelivery = { at: this.now(), eventId: event.id, ok, status, error, attempt };
    void this.db.put(this.collection, w.id, w).catch((e: Error) => this.logger.error({ err: e.message }, 'failed to save webhook'));
    if (ok) return;
    const delay = this.delays[attempt - 1];
    this.logger.warn({ webhook: w.id, event: event.id, attempt, error, retryInMs: delay ?? null }, 'webhook delivery failed');
    if (delay === undefined) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.deliver(w, event, attempt + 1);
    }, delay);
    t.unref();
    this.timers.add(t);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
