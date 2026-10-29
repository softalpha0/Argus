import crypto from 'node:crypto';
import type { DocStore } from '../db/DocStore.js';

interface Entry {
  fingerprint: string;
  executionId: string;
  createdAt: number;
}

export type Begin =
  | { kind: 'new' }
  | { kind: 'replay'; executionId: string }
  | { kind: 'mismatch' }
  | { kind: 'in_progress' };

const TTL_MS = 24 * 60 * 60_000;
const KEY_FORMAT = /^[\x21-\x7e]{1,200}$/;

export const validIdempotencyKey = (k: string) => KEY_FORMAT.test(k);

/** A stable hash of a request body, independent of key order. */
export function fingerprint(body: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(canon(body ?? null))).digest('hex');
}

/**
 * Idempotency-Key handling for POST /v1/executions. A retried request with the same
 * key and body returns the execution it already started instead of starting another;
 * the same key with a different body is refused. Keys are scoped to the caller and
 * remembered for 24 hours, across restarts. Failed requests are not remembered, so
 * they can be retried with the same key.
 */
export class Idempotency {
  private entries = new Map<string, Entry>();
  private inFlight = new Map<string, string>();

  constructor(
    private readonly db: DocStore,
    private readonly collection: string,
    private readonly now: () => number = Date.now,
    private readonly onWriteError: (err: Error) => void = () => {},
  ) {}

  async init(): Promise<void> {
    const all = await this.db.loadAll<Entry>(this.collection);
    this.entries = new Map();
    for (const [id, e] of all) {
      if (this.now() - e.createdAt < TTL_MS) this.entries.set(id, e);
      else void this.db.remove(this.collection, id).catch(this.onWriteError);
    }
  }

  private static id(scope: string, key: string): string {
    // Hashed so stored IDs don't reveal wallet addresses or client keys.
    return crypto.createHash('sha256').update(`${scope}\n${key}`).digest('hex').slice(0, 40);
  }

  begin(scope: string, key: string, fp: string): Begin {
    const id = Idempotency.id(scope, key);
    const e = this.entries.get(id);
    if (e && this.now() - e.createdAt < TTL_MS) return e.fingerprint === fp ? { kind: 'replay', executionId: e.executionId } : { kind: 'mismatch' };
    const pending = this.inFlight.get(id);
    if (pending !== undefined) return pending === fp ? { kind: 'in_progress' } : { kind: 'mismatch' };
    this.inFlight.set(id, fp);
    return { kind: 'new' };
  }

  async complete(scope: string, key: string, fp: string, executionId: string): Promise<void> {
    const id = Idempotency.id(scope, key);
    this.inFlight.delete(id);
    const e: Entry = { fingerprint: fp, executionId, createdAt: this.now() };
    this.entries.set(id, e);
    await this.db.put(this.collection, id, e).catch(this.onWriteError);
  }

  abort(scope: string, key: string): void {
    this.inFlight.delete(Idempotency.id(scope, key));
  }
}
