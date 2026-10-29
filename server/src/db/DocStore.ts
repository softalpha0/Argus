import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type pg from 'pg';

/**
 * Where Argus keeps its records: executions, wallet keys, sessions, API keys.
 * Each collection is loaded into memory at startup and written through on change,
 * so reads stay synchronous and the backend only has to store documents by ID.
 */
export interface DocStore {
  readonly kind: 'file' | 'postgres';
  loadAll<T>(collection: string): Promise<Map<string, T>>;
  put(collection: string, id: string, doc: unknown): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
  /** Waits for queued writes, then releases connections. */
  close(): Promise<void>;
}

/** Mainnet and testnet have separate Strike accounts, so their records live apart. */
export const scoped = (env: 'mainnet' | 'testnet', name: string): string => (env === 'mainnet' ? name : `${env}/${name}`);

/** Collections stored as append-only NDJSON (latest line per ID wins); the rest are one JSON object per file. */
const APPEND_ONLY = new Set(['executions']);

/**
 * Files under DATA_DIR, in the formats earlier versions wrote: executions.ndjson,
 * keys.json and sessions.json (testnet ones under testnet/). No database needed.
 */
export class FileDocStore implements DocStore {
  readonly kind = 'file';
  private readonly cache = new Map<string, Map<string, unknown>>();

  constructor(private readonly dir: string) {}

  private file(collection: string): string {
    const base = path.basename(collection);
    return path.join(this.dir, path.dirname(collection), APPEND_ONLY.has(base) ? `${base}.ndjson` : `${base}.json`);
  }

  private appendOnly(collection: string): boolean {
    return APPEND_ONLY.has(path.basename(collection));
  }

  private read(collection: string): Map<string, unknown> {
    const cached = this.cache.get(collection);
    if (cached) return cached;
    const docs = new Map<string, unknown>();
    const file = this.file(collection);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      if (this.appendOnly(collection)) {
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as { id?: string };
            if (rec?.id) docs.set(rec.id, rec);
          } catch {
            // A torn last line after a crash is skipped, not fatal.
          }
        }
      } else {
        try {
          for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, unknown>)) docs.set(k, v);
        } catch {
          // Start fresh on a corrupt file rather than refusing to boot.
        }
      }
    }
    this.cache.set(collection, docs);
    return docs;
  }

  async loadAll<T>(collection: string): Promise<Map<string, T>> {
    return new Map(this.read(collection)) as Map<string, T>;
  }

  async put(collection: string, id: string, doc: unknown): Promise<void> {
    const docs = this.read(collection);
    docs.set(id, doc);
    fs.mkdirSync(path.dirname(this.file(collection)), { recursive: true });
    if (this.appendOnly(collection)) fs.appendFileSync(this.file(collection), JSON.stringify(doc) + '\n');
    else this.flush(collection, docs);
  }

  async remove(collection: string, id: string): Promise<void> {
    const docs = this.read(collection);
    if (!docs.delete(id)) return;
    if (this.appendOnly(collection)) {
      fs.writeFileSync(this.file(collection), [...docs.values()].map((d) => JSON.stringify(d) + '\n').join(''));
    } else this.flush(collection, docs);
  }

  private flush(collection: string, docs: Map<string, unknown>): void {
    const file = this.file(collection);
    const tmp = file + '.tmp';
    // Owner-only: these files hold encrypted keys and session hashes.
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(docs), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  async close(): Promise<void> {}
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS argus_docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  doc JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
)`;

/** One table of JSON documents keyed by (collection, id). Writes run one at a time, in order. */
export class PgDocStore implements DocStore {
  readonly kind = 'postgres';
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly pool: pg.Pool) {}

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async loadAll<T>(collection: string): Promise<Map<string, T>> {
    await this.queue;
    const res = await this.pool.query<{ id: string; doc: T }>('SELECT id, doc FROM argus_docs WHERE collection = $1', [collection]);
    return new Map(res.rows.map((r) => [r.id, r.doc]));
  }

  put(collection: string, id: string, doc: unknown): Promise<void> {
    return this.enqueue(() =>
      this.pool.query(
        `INSERT INTO argus_docs (collection, id, doc) VALUES ($1, $2, $3)
         ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
        [collection, id, JSON.stringify(doc)],
      ),
    );
  }

  remove(collection: string, id: string): Promise<void> {
    return this.enqueue(() => this.pool.query('DELETE FROM argus_docs WHERE collection = $1 AND id = $2', [collection, id]));
  }

  // Ordered so a later write to the same record can never land before an earlier one.
  private enqueue(fn: () => Promise<unknown>): Promise<void> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run.then(() => {});
  }

  async close(): Promise<void> {
    await this.queue;
    await this.pool.end();
  }
}

/** Postgres when DATABASE_URL is set, otherwise files under DATA_DIR. */
export async function openDocStore(opts: { databaseUrl: string | null; dataDir: string }, logger: Logger): Promise<DocStore> {
  if (!opts.databaseUrl) {
    logger.info({ dir: opts.dataDir }, 'storing data in files');
    return new FileDocStore(opts.dataDir);
  }
  const { default: pgLib } = await import('pg');
  const store = new PgDocStore(new pgLib.Pool({ connectionString: opts.databaseUrl, max: 5 }));
  await store.init();
  logger.info('storing data in Postgres');
  return store;
}
