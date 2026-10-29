// Places one execution through the Argus v1 API, follows it live, and prints the receipt.
// No dependencies; Node 18 or newer.
//
//   ARGUS_URL=https://your-argus.example ARGUS_KEY=argus_... node examples/quickstart.mjs
//   node examples/quickstart.mjs --side sell --size 0.002 --deadline 120 --mode paper
//
// Paper mode (the default) trades against the real order book without placing orders.

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: arg } = parseArgs({
  options: {
    side: { type: 'string', default: 'buy' },
    size: { type: 'string', default: '0.002' },
    deadline: { type: 'string', default: '60' },
    mode: { type: 'string', default: 'paper' },
    fallback: { type: 'string', default: 'market' },
  },
});

const base = (process.env.ARGUS_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const key = process.env.ARGUS_KEY;
if (!key) {
  console.error('Set ARGUS_KEY to an API key (create one on the Argus site while signed in).');
  process.exit(1);
}
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

async function api(method, path, body, extra = {}) {
  const res = await fetch(base + path, { method, headers: { ...headers, ...extra }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${json.error?.type}: ${json.error?.message}`);
  return json;
}

// The Idempotency-Key makes this safe to retry: a repeat returns the same execution.
const execution = await api(
  'POST',
  '/v1/executions',
  { mode: arg.mode, side: arg.side, size: arg.size, deadlineSec: Number(arg.deadline), maxSlippageBps: 10, fallback: arg.fallback, clientRef: 'quickstart' },
  { 'idempotency-key': randomUUID() },
);
console.log(`Started ${execution.mode} ${execution.side} ${execution.size} on ${execution.venue.exchange} (${execution.venue.network}) as ${execution.id}`);

// Follow it on the event stream until the receipt arrives.
const res = await fetch(`${base}/v1/executions/${execution.id}/events`, { headers });
const decoder = new TextDecoder();
let buffer = '';
let receipt = null;
let lastLine = '';
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, i);
    buffer = buffer.slice(i + 2);
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!event || !data) continue;
    const d = JSON.parse(data);
    if (event === 'execution') {
      const q = d.workingOrder?.queue;
      // Print when something changes, not on every countdown tick.
      const line = `${d.state.padEnd(9)} filled ${d.filled}/${d.size}` + (d.workingOrder ? `  resting at ${d.workingOrder.price}${q?.place ? `, #${q.place} in line` : ''}` : '');
      if (line !== lastLine) console.log(`${line}  (${d.timeLeftSec ?? 0}s left)`);
      lastLine = line;
    } else if (event === 'fill') {
      console.log(`fill     ${d.size} at ${d.price} as ${d.liquidity}`);
    } else if (event === 'receipt') {
      receipt = d;
    }
  }
}

if (!receipt) throw new Error('Stream ended without a receipt');
console.log(`\nReceipt (${receipt.schema})`);
console.log(`  outcome     ${receipt.outcome}`);
if (receipt.result) {
  console.log(`  filled      ${receipt.result.filledSize} at avg ${receipt.result.avgPrice ?? '-'}, ${Math.round(Number(receipt.result.makerShare) * 100)}% as maker`);
  console.log(`  costs       venue fees ${receipt.costs.venueFees}, builder fee ${receipt.costs.builderFee}`);
  console.log(`  vs market   saved ${receipt.benchmark.saved ?? '-'} USD (${receipt.benchmark.savedBps ?? '-'} bps)`);
}
console.log(`\nFull receipt: GET ${base}/v1/executions/${execution.id}/receipt`);
