import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ExecutionManager } from '../src/engine/ExecutionManager.js';
import { FileDocStore } from '../src/db/DocStore.js';
import { Store } from '../src/store/Store.js';
import { ApiKeys } from '../src/users/ApiKeys.js';
import { Idempotency } from '../src/api/idempotency.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { walk } from '../src/mcp/tools.js';
import { fakeExchange, type FakeExchange } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mcp-'));
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
  const app = await buildApp(config, { logger: false, exchange, manager, store, accounts, apiKeys, idempotency, mcpPollMs: 50 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const { key } = await apiKeys.create('W1', { maxOrderUsd: 500, dailyUsd: 1000 });
  const connect = async (k = key) => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${k}` } } }));
    return client;
  };
  cleanups.push(async () => {
    await manager.shutdown();
    await app.close();
  });
  return { app, exchange, connect, url };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe('remote MCP', () => {
  it('needs an API key', async () => {
    const { url } = await setup();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
  });

  it('lists the Argus tools and reads the market', async () => {
    const { connect } = await setup();
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['argus_cancel', 'argus_execute', 'argus_list', 'argus_market', 'argus_quote', 'argus_receipt', 'argus_status']);
    expect(tools.find((t) => t.name === 'argus_execute')!.description).toMatch(/paper.*default/i);
    const market = await client.callTool({ name: 'argus_market', arguments: {} });
    expect(text(market)).toMatch(/BTC-USD: mid 100000.5, spread 1/);
    const quote = await client.callTool({ name: 'argus_quote', arguments: { side: 'buy', size: '0.002' } });
    const q = JSON.parse(text(quote).split('\n\n')[1]!);
    // Market buy takes the 100,001 ask (0.05 bps over mid) and pays the 5 bps taker fee.
    expect(q.marketOrder).toMatchObject({ avgPrice: 100001, priceImpactBps: 0.05, takerFeeBps: 5, totalCostBps: 5.05 });
    expect(q.makerThroughArgus).toMatchObject({ restingPrice: 100000, exchangeFeeBps: 0, argusFeeBps: 2 });
    await client.close();
  });

  it('runs a paper execution to a receipt, waiting in the same call', async () => {
    const { connect, exchange } = await setup({ bidSize: '0.01' });
    const client = await connect();
    // Trades reach our paper bid shortly after it rests at the best bid.
    setTimeout(() => {
      exchange.send({ action: 'full_fill', order_id: 'b1', side: 'buy', price: '100000', delta_size: '-0.01', remaining_size: '0', trade_id: 1 });
      exchange.send({ action: 'open', order_id: 'b2', side: 'buy', price: '100000', delta_size: '0.01', remaining_size: '0.01' });
      exchange.send({ action: 'partial_fill', order_id: 'b2', side: 'buy', price: '100000', delta_size: '-0.005', remaining_size: '0.005', trade_id: 2 });
    }, 300);
    const r = await client.callTool({ name: 'argus_execute', arguments: { side: 'buy', size: '0.002', deadlineSec: 60, waitSeconds: 10, clientRef: 'mcp-test' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/finished\. Receipt: filled\. Filled 0\.002 at an average of 100000, 100% as maker\. Saved/);
    const data = JSON.parse(text(r).split('\n\n')[1]!);
    expect(data.receipt).toMatchObject({ schema: 'argus.receipt.v1', mode: 'paper', clientRef: 'mcp-test' });
    await client.close();
  });

  it('starts, follows and cancels, and reports API errors as readable tool errors', async () => {
    const { connect } = await setup();
    const client = await connect();
    const started = await client.callTool({ name: 'argus_execute', arguments: { side: 'buy', size: '0.002' } });
    const id = JSON.parse(text(started).split('\n\n')[1]!).id;
    expect(text(started)).toMatch(/Started execution .* paper buy 0\.002/);
    expect(text(await client.callTool({ name: 'argus_receipt', arguments: { id } }))).toMatch(/Still running/);
    expect(text(await client.callTool({ name: 'argus_cancel', arguments: { id } }))).toMatch(/state canceled/);
    expect(text(await client.callTool({ name: 'argus_receipt', arguments: { id } }))).toMatch(/Receipt: not_filled/);
    expect(text(await client.callTool({ name: 'argus_list', arguments: {} }))).toContain(id);
    const over = await client.callTool({ name: 'argus_execute', arguments: { side: 'buy', size: '0.006', mode: 'live' } });
    expect(over.isError).toBe(true);
    expect(text(over)).toMatch(/limit_exceeded.*per-order limit of \$500/);
    await client.close();
  });
});

describe('walk', () => {
  it('averages across levels and reports partial depth', () => {
    const levels = [{ price: '100', total: '1' }, { price: '102', total: '1' }];
    expect(walk(levels, 1.5)).toEqual({ avg: (100 + 51) / 1.5, worst: 102, filled: 1.5 });
    expect(walk(levels, 5)!.filled).toBe(2);
    expect(walk([], 1)).toBeNull();
  });
});
