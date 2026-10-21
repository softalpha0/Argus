import fs from 'node:fs';
import path from 'node:path';

export interface StoredExecution {
  id: string;
  mode: 'paper' | 'live';
  owner: string | null;
  side: 'buy' | 'sell';
  size: string;
  state: string;
  createdAt: number;
  endedAt: number | null;
  [k: string]: unknown;
}

/** Append-only NDJSON store for finished executions, mirrored in memory. */
export class Store {
  private readonly file: string;
  private readonly byId = new Map<string, StoredExecution>();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'executions.ndjson');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as StoredExecution;
        if (rec?.id) this.byId.set(rec.id, rec);
      } catch {
        // A torn last line after a crash is skipped, not fatal.
      }
    }
  }

  save(rec: StoredExecution): void {
    this.byId.set(rec.id, rec);
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }

  get(id: string): StoredExecution | undefined {
    return this.byId.get(id);
  }

  all(): StoredExecution[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
