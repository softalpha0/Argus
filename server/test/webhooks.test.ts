import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { FileDocStore } from '../src/db/DocStore.js';
import { Webhooks, isPrivateAddress, signPayload, verifySignature } from '../src/webhooks/Webhooks.js';
import { ExecutionManager } from '../src/engine/ExecutionManager.js';
import { Store } from '../src/store/Store.js';
import { ApiKeys } from '../src/users/ApiKeys.js';
import { Idempotency } from '../src/api/idempotency.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { fakeExchange } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-wh-'));
const log = pino({ level: 'silent' });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A local receiver that answers with the given statuses in turn and records each request. */
async function receiver(statuses: number[]) {
  const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.writeHead(statuses[Math.min(got.length - 1, statuses.length - 1)]!).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, got };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

describe('webhook security', () => {
  it('recognises private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('signs and verifies, rejecting tampering and stale timestamps', () => {
    const now = 1_800_000_000;
    const sig = signPayload('whsec_x', '{"a":1}', now);
    expect(verifySignature('whsec_x', '{"a":1}', sig, 300, now + 10)).toBe(true);
    expect(verifySignature('whsec_x', '{"a":2}', sig, 300, now)).toBe(false);
    expect(verifySignature('whsec_y', '{"a":1}', sig, 300, now)).toBe(false);
    expect(verifySignature('whsec_x', '{"a":1}', sig, 300, now + 301)).toBe(false);
    expect(verifySignature('whsec_x', '{"a":1}', 'garbage', 300, now)).toBe(false);
  });

  it('refuses http, credentials and hosts that resolve to private networks', async () => {
    const resolve = async (h: string) => (h === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);
    const w = new Webhooks(new FileDocStore(tmp()), 'webhooks', log, { resolve });
    await w.init();
    await expect(w.create('W1', 'http://hooks.example/x')).rejects.toThrow(/https/);
    await expect(w.create('W1', 'https://user:pw@hooks.example/x')).rejects.toThrow(/credentials/);
    await expect(w.create('W1', 'https://internal.example/x')).rejects.toThrow(/public address/);
    await expect(w.create('W1', 'https://169.254.169.254/latest')).rejects.toThrow(/public address/);
    await expect(w.create('W1', 'not a url')).rejects.toThrow(/valid URL/);
    const { secret, webhook } = await w.create('W1', 'https://hooks.example/argus');
    expect(secret).toMatch(/^whsec_/);
    expect(webhook).not.toHaveProperty('secret');
  });
});

describe('webhook delivery', () => {
  it('delivers signed events, retries failures and records the outcome', async () => {
    const rx = await receiver([500, 200]);
    const dir = tmp();
    const w = new Webhooks(new FileDocStore(dir), 'webhooks', log, { allowInsecure: true, retryDelaysMs: [30], masterKeyHex: 'ab'.repeat(32) });
    await w.init();
    cleanups.push(() => w.stop());
    const { secret, webhook } = await w.create('W1', rx.url);
    // Sealed at rest: the secret itself never appears in storage.
    expect(fs.readFileSync(path.join(dir, 'webhooks.json'), 'utf8')).not.toContain(secret);
    const eventId = w.emit('W1', 'execution.finished', { hello: 'world' });
    w.emit('W2', 'execution.finished', { other: 'owner' });
    await waitFor(() => rx.got.length === 2);
    for (const r of rx.got) {
      expect(r.headers['argus-event-id']).toBe(eventId);
      expect(verifySignature(secret, r.body, String(r.headers['argus-signature']))).toBe(true);
      expect(JSON.parse(r.body)).toMatchObject({ id: eventId, type: 'execution.finished', data: { hello: 'world' } });
    }
    await waitFor(() => w.list('W1')[0]!.lastDelivery?.ok === true);
    expect(w.list('W1')[0]!.lastDelivery).toMatchObject({ ok: true, status: 200, attempt: 2 });
    expect(await w.remove('W2', webhook.id)).toBe(false);
    expect(await w.remove('W1', webhook.id)).toBe(true);
  });

  it('sends execution.finished with the receipt when an execution ends', async () => {
    const rx = await receiver([200]);
    const config = loadConfig({ STRIKE_ENV: 'testnet', BUILDER_CODE: 'Argus', ARGUS_MASTER_KEY: 'ab'.repeat(32), DATA_DIR: tmp() });
    const db = new FileDocStore(tmp());
    const store = await Store.open(db);
    const apiKeys = new ApiKeys(db, 'testnet/api-keys');
    await apiKeys.init();
    const idempotency = new Idempotency(db, 'testnet/idempotency');
    await idempotency.init();
    const webhooks = new Webhooks(db, 'testnet/webhooks', log, { allowInsecure: true });
    await webhooks.init();
    const manager = new ExecutionManager(config, fakeExchange(), store, log);
    const accounts = { sessions: { get: (t?: string) => (t === 'good' ? { address: 'W1' } : undefined) } } as never;
    const app = await buildApp(config, { logger: false, exchange: fakeExchange(), manager, store, accounts, apiKeys, idempotency, webhooks });
    cleanups.push(async () => {
      await manager.shutdown();
      await app.close();
      webhooks.stop();
    });
    const session = { cookie: 'argus_session_testnet=good' };
    // Managed from a session only.
    expect((await app.inject({ method: 'POST', url: '/api/webhooks', payload: { url: rx.url } })).statusCode).toBe(401);
    const { key } = await apiKeys.create('W1', {});
    expect((await app.inject({ method: 'POST', url: '/api/webhooks', headers: { authorization: `Bearer ${key}` }, payload: { url: rx.url } })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/webhooks', headers: session, payload: { url: rx.url } });
    expect(created.statusCode).toBe(201);
    const { secret } = created.json();
    expect((await app.inject({ method: 'GET', url: '/api/webhooks', headers: session })).json().webhooks).toHaveLength(1);

    const auth = { authorization: `Bearer ${key}` };
    const e = (await app.inject({ method: 'POST', url: '/v1/executions', headers: auth, payload: { mode: 'paper', side: 'buy', size: '0.002', clientRef: 'hooked' } })).json();
    await app.inject({ method: 'POST', url: `/v1/executions/${e.id}/cancel`, headers: auth });
    await waitFor(() => rx.got.length === 1);
    const body = JSON.parse(rx.got[0]!.body);
    expect(verifySignature(secret, rx.got[0]!.body, String(rx.got[0]!.headers['argus-signature']))).toBe(true);
    expect(body).toMatchObject({ type: 'execution.finished', data: { execution: { id: e.id, state: 'canceled', clientRef: 'hooked' }, receipt: { schema: 'argus.receipt.v1', executionId: e.id } } });
  });
});
