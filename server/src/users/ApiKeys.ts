import crypto from 'node:crypto';
import type { DocStore } from '../db/DocStore.js';

export interface ApiKeyLimits {
  /** Largest single live order, in USD at the mid when it starts. */
  maxOrderUsd: number;
  /** Total live notional per UTC day across this key's executions. */
  dailyUsd: number;
}

export interface ApiKeyRecord {
  id: string;
  /** Wallet address the key acts for. */
  owner: string;
  name: string;
  /** SHA-256 of the full key; the key itself is shown once and never stored. */
  hash: string;
  limits: ApiKeyLimits;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export type PublicApiKey = Omit<ApiKeyRecord, 'hash' | 'owner'> & { prefix: string };

export const DEFAULT_LIMITS: ApiKeyLimits = { maxOrderUsd: 500, dailyUsd: 2_000 };
export const MAX_LIMITS: ApiKeyLimits = { maxOrderUsd: 100_000, dailyUsd: 1_000_000 };
const MAX_ACTIVE_KEYS = 10;
// Persist "last used" at most this often per key; it is informational.
const TOUCH_EVERY_MS = 60_000;
const KEY_FORMAT = /^argus_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export class ApiKeyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function parseLimits(input: { maxOrderUsd?: unknown; dailyUsd?: unknown }): ApiKeyLimits {
  const num = (v: unknown, name: keyof ApiKeyLimits): number => {
    if (v === undefined || v === null || v === '') return DEFAULT_LIMITS[name];
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new ApiKeyError(`${name} must be a positive number of USD`);
    if (n > MAX_LIMITS[name]) throw new ApiKeyError(`${name} can be at most ${MAX_LIMITS[name]}`);
    return Math.round(n * 100) / 100;
  };
  const limits = { maxOrderUsd: num(input.maxOrderUsd, 'maxOrderUsd'), dailyUsd: num(input.dailyUsd, 'dailyUsd') };
  if (limits.maxOrderUsd > limits.dailyUsd) throw new ApiKeyError('maxOrderUsd cannot be larger than dailyUsd');
  return limits;
}

export function toPublic(k: ApiKeyRecord): PublicApiKey {
  const { hash: _hash, owner: _owner, ...rest } = k;
  return { ...rest, prefix: `argus_${k.id}_…` };
}

/** API keys that let a program act for a connected wallet: trade only, within limits. */
export class ApiKeys {
  private byId = new Map<string, ApiKeyRecord>();
  private lastPersistedUse = new Map<string, number>();

  constructor(
    private readonly db: DocStore,
    private readonly collection: string,
    private readonly now: () => number = Date.now,
    private readonly onWriteError: (err: Error) => void = () => {},
  ) {}

  async init(): Promise<void> {
    this.byId = await this.db.loadAll<ApiKeyRecord>(this.collection);
  }

  /** Returns the full key once; only its hash is kept. */
  async create(owner: string, opts: { name?: unknown; maxOrderUsd?: unknown; dailyUsd?: unknown }): Promise<{ key: string; apiKey: PublicApiKey }> {
    const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 60) : 'API key';
    const limits = parseLimits(opts);
    if (this.list(owner).filter((k) => !k.revokedAt).length >= MAX_ACTIVE_KEYS) {
      throw new ApiKeyError(`You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    }
    const id = crypto.randomBytes(6).toString('hex');
    const key = `argus_${id}_${crypto.randomBytes(32).toString('base64url')}`;
    const rec: ApiKeyRecord = { id, owner, name, hash: sha256(key), limits, createdAt: this.now() };
    this.byId.set(id, rec);
    await this.db.put(this.collection, id, rec);
    return { key, apiKey: toPublic(rec) };
  }

  list(owner: string): PublicApiKey[] {
    return [...this.byId.values()].filter((k) => k.owner === owner).sort((a, b) => b.createdAt - a.createdAt).map(toPublic);
  }

  /** Revokes one of the owner's keys. Returns undefined if it isn't theirs. */
  async revoke(owner: string, id: string): Promise<ApiKeyRecord | undefined> {
    const k = this.byId.get(id);
    if (!k || k.owner !== owner) return undefined;
    if (!k.revokedAt) {
      k.revokedAt = this.now();
      await this.db.put(this.collection, id, k);
    }
    return k;
  }

  /** The active key for a presented token, or undefined. Constant-time on the secret. */
  verify(token: string): ApiKeyRecord | undefined {
    const m = KEY_FORMAT.exec(token);
    if (!m) return undefined;
    const k = this.byId.get(m[1]!);
    if (!k || k.revokedAt) return undefined;
    const a = Buffer.from(sha256(token), 'hex');
    const b = Buffer.from(k.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
    this.touch(k);
    return k;
  }

  private touch(k: ApiKeyRecord): void {
    const now = this.now();
    k.lastUsedAt = now;
    if (now - (this.lastPersistedUse.get(k.id) ?? 0) < TOUCH_EVERY_MS) return;
    this.lastPersistedUse.set(k.id, now);
    void this.db.put(this.collection, k.id, k).catch(this.onWriteError);
  }
}
