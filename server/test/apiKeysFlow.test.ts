import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { Decimal } from 'decimal.js';
import { OrderBook } from '../src/book/OrderBook.js';
import { MarketModel } from '../src/model/MarketModel.js';
import { parseSymbolRules } from '../src/strike/exchangeInfo.js';
import type { Exchange, MarketData, MarketEvents } from '../src/exchange/Exchange.js';
import { ExecutionManager } from '../src/engine/ExecutionManager.js';
import { FileDocStore } from '../src/db/DocStore.js';
import { Store } from '../src/store/Store.js';
import { ApiKeys, type ApiKeyRecord } from '../src/users/ApiKeys.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import type { ExecutionParams } from '../src/engine/Execution.js';

const rules = parseSymbolRules(
  {
    symbols: [{ symbol: 'BTC-USD', status: 'trading', filters: [
      { filterType: 'PRICE_FILTER', maxPrice: '1000000', minPrice: '10', tickSize: '1' },
      { filterType: 'LOT_SIZE', maxQty: '1000', minQty: '0.00001', stepSize: '0.00001' },
      { filterType: 'MIN_NOTIONAL', notional: '10' },
    ] }],
  },
  'BTC-USD',
);

const NOW = Date.UTC(2026, 9, 29, 12);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-flow-'));

/** An exchange with a real book (mid 100,000.5) and a live venue that only records that it was reached. */
function fakeExchange(): Exchange & { createLiveVenue: ReturnType<typeof vi.fn> } {
  const book = new OrderBook();
  book.loadSnapshot({
    type: 'l3_snapshot', symbol: 'BTC-USD', last_sequence: 0, timestamp: NOW,
    bids: [{ price: '100000', orders: [{ order_id: 'b1', size: '0.5' }] }],
    asks: [{ price: '100001', orders: [{ order_id: 'a1', size: '0.5' }] }],
  });
  const model = new MarketModel(book);
  model.markStart(NOW);
  const market = Object.assign(new EventEmitter<MarketEvents>(), {
    symbol: 'BTC-USD', book, model, isLive: true, rules, recentTrades: () => [], health: () => ({ sync: { state: 'live' } }),
  }) as MarketData;
  return {
    id: 'fake', name: 'Fake', market, start: async () => {}, stop: () => {},
    createLiveVenue: vi.fn(async () => { throw new Error('live venue reached'); }),
  };
}

const config = () => loadConfig({ STRIKE_ENV: 'testnet', BUILDER_CODE: 'Argus', ARGUS_MASTER_KEY: 'ab'.repeat(32), DATA_DIR: tmp() });
const params = (size: string, mode: 'live' | 'paper' = 'live'): ExecutionParams => ({
  mode, side: 'buy', size: new Decimal(size), deadlineSec: 60, maxSlippageBps: 10, preset: 'balanced', fallback: 'cancel',
});
const key = (limits = { maxOrderUsd: 500, dailyUsd: 1000 }): ApiKeyRecord => ({ id: 'k1', owner: 'W1', name: 'bot', hash: 'x', limits, createdAt: NOW });

let managers: ExecutionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  managers = [];
});

async function manager(store?: Store) {
  const exchange = fakeExchange();
  const s = store ?? (await Store.open(new FileDocStore(tmp())));
  const m = new ExecutionManager(config(), exchange, s, pino({ level: 'silent' }), () => NOW);
  managers.push(m);
  return { m, exchange, store: s };
}

describe('API key limits', () => {
  it('blocks a live order over the per-order limit before touching the exchange', async () => {
    const { m, exchange } = await manager();
    // 0.006 BTC at a 100,000.5 mid is about $600.
    await expect(m.create(params('0.006'), 'W1', { apiKey: key() })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/per-order limit of \$500/) });
    expect(exchange.createLiveVenue).not.toHaveBeenCalled();
    // About $400 is within the limit, so it goes on to the exchange.
    await expect(m.create(params('0.004'), 'W1', { apiKey: key() })).rejects.toThrow('live venue reached');
    expect(exchange.createLiveVenue).toHaveBeenCalledTimes(1);
  });

  it("counts today's live usage, ignoring yesterday, paper runs and other keys", async () => {
    const store = await Store.open(new FileDocStore(tmp()));
    const rec = (id: string, extra: Record<string, unknown>) =>
      store.save({ id, mode: 'live', owner: 'W1', side: 'buy', size: '0.007', state: 'done', createdAt: NOW - 60_000, endedAt: NOW, arrivalMid: '100000', apiKeyId: 'k1', ...extra });
    await rec('today', {});
    await rec('yesterday', { createdAt: NOW - 24 * 3600_000 });
    await rec('paper', { mode: 'paper' });
    await rec('other-key', { apiKeyId: 'k2' });
    const { m } = await manager(store);
    expect(m.usageToday('k1')).toBeCloseTo(700, 6);
    // $700 used plus about $400 is over the $1,000 daily limit.
    await expect(m.create(params('0.004'), 'W1', { apiKey: key() })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/daily limit of \$1,000/) });
    // Without an API key (a signed-in person in the browser), no key limits apply.
    await expect(m.create(params('0.004'), 'W1')).rejects.toThrow('live venue reached');
  });

  it('stops running executions when their key is revoked, and records the key on saved runs', async () => {
    const { m, store } = await manager();
    const e = await m.create(params('0.001', 'paper'), 'W1', { apiKey: key() });
    await m.create(params('0.001', 'paper'), 'W1');
    expect(await m.cancelByApiKey('k1')).toBe(1);
    expect(e.isFinished).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(store.get(e.id)?.apiKeyId).toBe('k1');
    expect(m.running()).toHaveLength(1);
  });
});

describe('HTTP: API keys and executions', () => {
  async function app() {
    const cfg = config();
    const db = new FileDocStore(tmp());
    const exchange = fakeExchange();
    const store = await Store.open(db);
    const apiKeys = new ApiKeys(db, 'testnet/api-keys', () => NOW);
    await apiKeys.init();
    const m = new ExecutionManager(cfg, exchange, store, pino({ level: 'silent' }), () => NOW);
    managers.push(m);
    const accounts = { sessions: { get: (t?: string) => (t === 'good' ? { address: 'W1' } : undefined), destroy: () => {} } } as never;
    const a = await buildApp(cfg, { logger: false, exchange, manager: m, store, accounts, apiKeys });
    return { a, exchange };
  }
  const session = { cookie: 'argus_session_testnet=good' };

  it('creates, lists and revokes keys from a session only', async () => {
    const { a } = await app();
    expect((await a.inject({ method: 'POST', url: '/api/keys', payload: {} })).statusCode).toBe(401);
    const created = await a.inject({ method: 'POST', url: '/api/keys', headers: session, payload: { name: 'bot', maxOrderUsd: 500, dailyUsd: 1000 } });
    expect(created.statusCode).toBe(201);
    const { key, apiKey } = created.json();
    // A key can't be used to manage keys.
    expect((await a.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${key}` }, payload: {} })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(403);
    const list = (await a.inject({ method: 'GET', url: '/api/keys', headers: session })).json();
    expect(list.keys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key);
    expect((await a.inject({ method: 'DELETE', url: `/api/keys/nope`, headers: session })).statusCode).toBe(404);
    const revoked = await a.inject({ method: 'DELETE', url: `/api/keys/${apiKey.id}`, headers: session });
    expect(revoked.json()).toMatchObject({ apiKey: { id: apiKey.id }, stoppedExecutions: 0 });
    expect((await a.inject({ method: 'GET', url: '/api/executions', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
    await a.close();
  });

  it('runs executions with an API key, enforcing its limits', async () => {
    const { a } = await app();
    const { key } = (await a.inject({ method: 'POST', url: '/api/keys', headers: session, payload: { maxOrderUsd: 500, dailyUsd: 1000 } })).json();
    const auth = { authorization: `Bearer ${key}` };
    const over = await a.inject({ method: 'POST', url: '/api/executions', headers: auth, payload: { mode: 'live', side: 'buy', size: '0.006' } });
    expect(over.statusCode).toBe(403);
    expect(over.json().error).toMatch(/per-order limit/);
    const paper = await a.inject({ method: 'POST', url: '/api/executions', headers: auth, payload: { mode: 'paper', side: 'buy', size: '0.001', deadlineSec: 60 } });
    expect(paper.statusCode).toBe(201);
    const bad = await a.inject({ method: 'POST', url: '/api/executions', headers: { authorization: 'Bearer argus_000000000000_' + 'x'.repeat(43) }, payload: { side: 'buy', size: '0.001' } });
    expect(bad.statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/market' })).json()).toMatchObject({ symbol: 'BTC-USD', live: true, sync: { state: 'live' } });
    await a.close();
  });
});
