import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Session {
  address: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = 'argus_session';

/** Random session tokens; only their SHA-256 is kept, so the file alone can't sign anyone in. */
export class Sessions {
  private readonly file: string;
  private byHash = new Map<string, Session>();

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'sessions.json');
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Session>;
        for (const [h, s] of Object.entries(raw)) if (s.expiresAt > this.now()) this.byHash.set(h, s);
      } catch {
        /* start fresh on a corrupt file */
      }
    }
  }

  private static hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  create(address: string, accountId: string): { token: string; session: Session } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const session = { address, accountId, createdAt: now, expiresAt: now + TTL_MS };
    this.byHash.set(Sessions.hash(token), session);
    this.flush();
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
    if (token && this.byHash.delete(Sessions.hash(token))) this.flush();
  }

  private flush(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byHash)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export const sessionTtlSec = TTL_MS / 1000;
