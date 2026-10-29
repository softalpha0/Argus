import crypto from 'node:crypto';
import type { DocStore } from '../db/DocStore.js';

export interface Session {
  address: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = 'argus_session';
/** Mainnet and testnet sign-ins are separate accounts, so they get separate cookies. */
export const sessionCookie = (env: 'mainnet' | 'testnet') => (env === 'mainnet' ? SESSION_COOKIE : `${SESSION_COOKIE}_${env}`);

/** Random session tokens; only their SHA-256 is kept, so stored data alone can't sign anyone in. */
export class Sessions {
  private byHash = new Map<string, Session>();

  /** `collection` is e.g. "sessions" or "testnet/sessions"; call init() before use. */
  constructor(
    private readonly db: DocStore,
    private readonly collection: string,
    private readonly now: () => number = Date.now,
    private readonly onWriteError: (err: Error) => void = () => {},
  ) {}

  async init(): Promise<void> {
    const all = await this.db.loadAll<Session>(this.collection);
    this.byHash = new Map();
    for (const [h, s] of all) {
      if (s.expiresAt > this.now()) this.byHash.set(h, s);
      else void this.db.remove(this.collection, h).catch(this.onWriteError);
    }
  }

  private static hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  create(address: string, accountId: string): { token: string; session: Session } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const session = { address, accountId, createdAt: now, expiresAt: now + TTL_MS };
    const h = Sessions.hash(token);
    this.byHash.set(h, session);
    void this.db.put(this.collection, h, session).catch(this.onWriteError);
    return { token, session };
  }

  get(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const s = this.byHash.get(Sessions.hash(token));
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.destroy(token);
      return undefined;
    }
    return s;
  }

  destroy(token: string | undefined): void {
    if (!token) return;
    const h = Sessions.hash(token);
    if (this.byHash.delete(h)) void this.db.remove(this.collection, h).catch(this.onWriteError);
  }
}

export const sessionTtlSec = TTL_MS / 1000;
