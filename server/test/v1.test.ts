import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ExecutionManager } from '../src/engine/ExecutionManager.js';
import { FileDocStore } from '../src/db/DocStore.js';
import { Store } from '../src/store/Store.js';
import { ApiKeys } from '../src/users/ApiKeys.js';
import { Idempotency, fingerprint } from '../src/api/idempotency.js';
import { RECEIPT_SCHEMA } from '../src/api/receipt.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { fakeExchange, type FakeExchange } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-v1-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(opts: { bidSize?: string } = {}) {
  const config = loadConfig({ STRIKE_ENV: 'testnet', BUILDER_CODE: 'Argus', ARGUS_MASTER_KEY: 'ab'.repeat(32), DATA_DIR: tmp() });
  const db = new FileDocStore(tmp());
  const exchange: FakeExchange = fakeExchange({ bidSize: opts.bidSize });
  const store = await Store.open(db);
  const apiKeys = new ApiKeys(db, 'testnet/api-keys');
  await apiKeys.init();
  const idempotency = new Idempotency(db, 'testnet/idempotency');
  await idempotency.init();
  const manager = new ExecutionManager(config, exchange, store, pino({ level: 'silent' }));
  const accounts = { sessions: { get: () => undefined } } as never;
  const app = await buildApp(config, { logger: false, exchange, manager, store, accounts, apiKeys, idempotency, streamTickMs: 20 });
  const { key } = await apiKeys.create('W1', { maxOrderUsd: 500, dailyUsd: 1000 });
  const { key: otherKey } = await apiKeys.create('W2', {});
  cleanups.push(async () => {
    await manager.shutdown();
    await app.close();
  });
  const h = (k = key) => ({ authorization: `Bearer ${k}` });
  return { app, manager, exchange, db, h, otherKey };
}

const paper = { mode: 'paper', side: 'buy', size: '0.002', deadlineSec: 60, fallback: 'cancel' };

describe('/v1 executions', () => {
  it('needs an API key and answers with typed errors', async () => {
    const { app, h } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/executions' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { type: 'unauthorized', message: expect.stringMatching(/Bearer/) } });
    const bad = await app.inject({ method: 'POST', url: '/v1/executions', headers: h(), payload: { side: 'hold', size: '1' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.type).toBe('invalid_request');
    const over = await app.inject({ method: 'POST', url: '/v1/executions', headers: h(), payload: { ...paper, mode: 'live', size: '0.006' } });
    expect(over.statusCode).toBe(403);
    expect(over.json().error.type).toBe('limit_exceeded');
  });

  it('starts, lists, shows and cancels, and only shows the caller its own executions', async () => {
    const { app, h, otherKey } = await setup();
    const created = await app.inject({ method: 'POST', url: '/v1/executions', headers: h(), payload: { ...paper, clientRef: 'rebalance-42' } });
    expect(created.statusCode).toBe(201);
    const e = created.json();
    expect(e).toMatchObject({ object: 'execution', clientRef: 'rebalance-42', venue: { exchange: 'fake', network: 'testnet', symbol: 'BTC-USD' }, mode: 'paper', state: 'working', outcome: null, receipt: null });
    await wait(50);
    const shown = (await app.inject({ method: 'GET', url: `/v1/executions/${e.id}`, headers: h() })).json();
    expect(shown.workingOrder).toMatchObject({ price: '100000', queue: { place: 2 } });
    expect((await app.inject({ method: 'GET', url: `/v1/executions/${e.id}`, headers: h(otherKey) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/executions', headers: h(otherKey) })).json().data).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/executions', headers: h() })).json().data.map((x: { id: string }) => x.id)).toEqual([e.id]);
    const early = await app.inject({ method: 'GET', url: `/v1/executions/${e.id}/receipt`, headers: h() });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.type).toBe('not_ready');
    const canceled = (await app.inject({ method: 'POST', url: `/v1/executions/${e.id}/cancel`, headers: h() })).json();
    expect(canceled).toMatchObject({ state: 'canceled', outcome: 'not_filled', receipt: `/v1/executions/${e.id}/receipt` });
    // Cancelling again is a harmless no-op.
    expect((await app.inject({ method: 'POST', url: `/v1/executions/${e.id}/cancel`, headers: h() })).json().state).toBe('canceled');
    const receipt = (await app.inject({ method: 'GET', url: `/v1/executions/${e.id}/receipt`, headers: h() })).json();
    expect(receipt).toMatchObject({ schema: RECEIPT_SCHEMA, executionId: e.id, clientRef: 'rebalance-42', state: 'canceled', outcome: 'not_filled', fills: [] });
    expect(receipt.apiKeyId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('makes retries with the same Idempotency-Key safe', async () => {
    const { app, h } = await setup();
    const post = (key: string, body = paper) => app.inject({ method: 'POST', url: '/v1/executions', headers: { ...h(), 'idempotency-key': key }, payload: body });
    const first = await post('order-1');
    expect(first.statusCode).toBe(201);
    const again = await post('order-1');
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    const reused = await post('order-1', { ...paper, size: '0.003' });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.type).toBe('idempotency_key_reused');
    // A failed request isn't remembered, so it can be retried with the same key.
    expect((await post('order-2', { ...paper, mode: 'live', size: '0.006' })).statusCode).toBe(403);
    expect((await post('order-2', { ...paper, size: '0.001' })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/v1/executions', headers: { ...h(), 'idempotency-key': '' }, payload: paper })).statusCode).toBe(400);
  });

  it('streams updates and a fill, then the receipt, then closes', async () => {
    const { app, h, exchange } = await setup({ bidSize: '0.01' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const e = await (await fetch(`${base}/v1/executions`, { method: 'POST', headers: { ...h(), 'content-type': 'application/json' }, body: JSON.stringify(paper) })).json();
    const res = await fetch(`${base}/v1/executions/${e.id}/events`, { headers: h() });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events: { event: string; data: { state?: string; liquidity?: string; schema?: string; outcome?: string } }[] = [];
    const reading = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    })();
    await wait(100);
    // Sellers trade through the order ahead of ours, then into one behind it: our paper bid fills as maker.
    exchange.send({ action: 'full_fill', order_id: 'b1', side: 'buy', price: '100000', delta_size: '-0.01', remaining_size: '0', trade_id: 1 });
    exchange.send({ action: 'open', order_id: 'b2', side: 'buy', price: '100000', delta_size: '0.01', remaining_size: '0.01' });
    exchange.send({ action: 'partial_fill', order_id: 'b2', side: 'buy', price: '100000', delta_size: '-0.005', remaining_size: '0.005', trade_id: 2 });
    await reading;
    const kinds = events.map((x) => x.event);
    expect(kinds[0]).toBe('execution');
    expect(kinds).toContain('fill');
    expect(events.find((x) => x.event === 'fill')!.data.liquidity).toBe('maker');
    expect(kinds.at(-1)).toBe('receipt');
    expect(events.at(-1)!.data).toMatchObject({ schema: RECEIPT_SCHEMA, outcome: 'filled' });
    expect(events.at(-2)!.data.state).toBe('done');
    // A finished execution's stream replies at once with the final view and receipt.
    const after = await (await fetch(`${base}/v1/executions/${e.id}/events`, { headers: h() })).text();
    expect(after.match(/^event: (\w+)/gm)).toEqual(['event: execution', 'event: receipt']);
  });
});

describe('Idempotency', () => {
  it('remembers keys across a restart and forgets them after 24 hours', async () => {
    const dir = tmp();
    let now = 1_000_000;
    const open = async () => {
      const i = new Idempotency(new FileDocStore(dir), 'idem', () => now);
      await i.init();
      return i;
    };
    const a = await open();
    expect(a.begin('W1', 'k', 'fp')).toEqual({ kind: 'new' });
    expect(a.begin('W1', 'k', 'fp')).toEqual({ kind: 'in_progress' });
    await a.complete('W1', 'k', 'fp', 'e1');
    // Other callers' keys are separate.
    expect(a.begin('W2', 'k', 'fp')).toEqual({ kind: 'new' });
    const b = await open();
    expect(b.begin('W1', 'k', 'fp')).toEqual({ kind: 'replay', executionId: 'e1' });
    expect(b.begin('W1', 'k', 'other')).toEqual({ kind: 'mismatch' });
    now += 24 * 3600_000 + 1;
    const c = await open();
    expect(c.begin('W1', 'k', 'fp')).toEqual({ kind: 'new' });
  });

  it('fingerprints bodies regardless of key order', () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(fingerprint({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
