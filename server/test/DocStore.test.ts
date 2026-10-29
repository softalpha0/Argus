import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type pg from 'pg';
import { FileDocStore, PgDocStore, scoped, type DocStore } from '../src/db/DocStore.js';
import { Store, type StoredExecution } from '../src/store/Store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-db-'));

/** One in-memory Postgres per test; `reopen` gives a second store on the same database. */
async function pgPair(): Promise<{ store: DocStore; reopen: () => Promise<DocStore> }> {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool() as unknown as pg.Pool;
  const store = new PgDocStore(pool);
  await store.init();
  return { store, reopen: async () => new PgDocStore(pool) };
}

function filePair(): { store: DocStore; reopen: () => Promise<DocStore> } {
  const dir = tmp();
  return { store: new FileDocStore(dir), reopen: async () => new FileDocStore(dir) };
}

/** A real server, when TEST_DATABASE_URL is set; each test gets its own schema. */
async function realPgPair(): Promise<{ store: DocStore; reopen: () => Promise<DocStore> }> {
  const { default: pgLib } = await import('pg');
  const schema = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pgLib.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = () => new pgLib.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const store = new PgDocStore(pool());
  await store.init();
  return { store, reopen: async () => new PgDocStore(pool()) };
}

const backends: [string, () => Promise<{ store: DocStore; reopen: () => Promise<DocStore> }>][] = [
  ['files', async () => filePair()],
  ['postgres (in memory)', pgPair],
  ...(process.env.TEST_DATABASE_URL ? [['postgres (server)', realPgPair] as [string, typeof realPgPair]] : []),
];

describe.each(backends)('DocStore on %s', (_name, make) => {
  it('stores, overwrites and removes documents, and keeps them across a restart', async () => {
    const { store, reopen } = await make();
    await store.put('keys', 'W1', { address: 'W1', n: 1 });
    await store.put('keys', 'W2', { address: 'W2', n: 1 });
    await store.put('keys', 'W1', { address: 'W1', n: 2 });
    await store.put('testnet/keys', 'W1', { address: 'W1', n: 9 });
    await store.remove('keys', 'W2');
    const again = await reopen();
    const keys = await again.loadAll<{ n: number }>('keys');
    expect([...keys.keys()]).toEqual(['W1']);
    expect(keys.get('W1')!.n).toBe(2);
    // Networks don't see each other's records.
    expect((await again.loadAll<{ n: number }>('testnet/keys')).get('W1')!.n).toBe(9);
    expect((await again.loadAll('nothing-here')).size).toBe(0);
  });

  it('applies rapid writes to one record in order', async () => {
    const { store, reopen } = await make();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.put('executions', 'e1', { id: 'e1', v: i })));
    expect((await (await reopen()).loadAll<{ v: number }>('executions')).get('e1')!.v).toBe(19);
  });

  it('backs the execution Store', async () => {
    const { store, reopen } = await make();
    const s = await Store.open(store);
    const rec = (id: string, createdAt: number): StoredExecution => ({ id, mode: 'paper', owner: null, side: 'buy', size: '0.001', state: 'done', createdAt, endedAt: createdAt + 1 });
    await s.save(rec('b', 2));
    await s.save(rec('a', 1));
    const s2 = await Store.open(await reopen());
    expect(s2.all().map((r) => r.id)).toEqual(['a', 'b']);
    expect(s2.get('b')?.createdAt).toBe(2);
  });
});

describe('FileDocStore', () => {
  it('reads and writes the same files earlier versions used', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'testnet'));
    fs.writeFileSync(path.join(dir, 'executions.ndjson'), '{"id":"x1","createdAt":1}\n{"id":"x1","createdAt":2}\n{"id":"torn');
    fs.writeFileSync(path.join(dir, 'testnet', 'sessions.json'), JSON.stringify({ h1: { address: 'W' } }));
    const db = new FileDocStore(dir);
    const execs = await db.loadAll<{ createdAt: number }>('executions');
    // Latest line wins; a torn last line is skipped.
    expect(execs.get('x1')!.createdAt).toBe(2);
    expect((await db.loadAll(scoped('testnet', 'sessions'))).has('h1')).toBe(true);
    await db.put(scoped('testnet', 'keys'), 'W', { address: 'W' });
    expect(fs.existsSync(path.join(dir, 'testnet', 'keys.json'))).toBe(true);
  });
});
