import type { DocStore } from '../db/DocStore.js';

export interface StoredExecution {
  id: string;
  mode: 'paper' | 'live';
  owner: string | null;
  side: 'buy' | 'sell';
  size: string;
  state: string;
  createdAt: number;
  endedAt: number | null;
  /** Set when the execution was started with an API key. */
  apiKeyId?: string;
  /** The caller's own reference, if given. */
  clientRef?: string;
  [k: string]: unknown;
}

const COLLECTION = 'executions';

/** Finished executions, held in memory and written through to the DocStore. */
export class Store {
  private byId = new Map<string, StoredExecution>();

  constructor(
    private readonly db: DocStore,
    private readonly onWriteError: (err: Error, id: string) => void = () => {},
  ) {}

  static async open(db: DocStore, onWriteError?: (err: Error, id: string) => void): Promise<Store> {
    const s = new Store(db, onWriteError);
    await s.init();
    return s;
  }

  async init(): Promise<void> {
    this.byId = await this.db.loadAll<StoredExecution>(COLLECTION);
  }

  save(rec: StoredExecution): Promise<void> {
    this.byId.set(rec.id, rec);
    return this.db.put(COLLECTION, rec.id, rec).catch((err: Error) => this.onWriteError(err, rec.id));
  }

  get(id: string): StoredExecution | undefined {
    return this.byId.get(id);
  }

  all(): StoredExecution[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
