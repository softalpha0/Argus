/**
 * Runs a batch of paper executions on the live mainnet book and prints each report.
 *
 *   npx tsx scripts/paper-runs.ts
 */
import pino from 'pino';
import { Decimal } from 'decimal.js';
import { loadConfig } from '../src/config.js';
import { StrikeExchange } from '../src/strike/StrikeExchange.js';
import { FileDocStore } from '../src/db/DocStore.js';
import { Store } from '../src/store/Store.js';
import { ExecutionManager } from '../src/engine/ExecutionManager.js';
import type { Execution, ExecutionParams } from '../src/engine/Execution.js';
import { computeStats } from '../src/store/stats.js';

const config = loadConfig();
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
const exchange = new StrikeExchange(config, null, logger);
const store = await Store.open(new FileDocStore(config.dataDir));
const manager = new ExecutionManager(config, exchange, store, logger);

const runs: Omit<ExecutionParams, 'mode'>[] = [
  { side: 'buy', size: new Decimal('0.0002'), deadlineSec: 120, maxSlippageBps: 10, preset: 'balanced', fallback: 'market' },
  { side: 'sell', size: new Decimal('0.0002'), deadlineSec: 120, maxSlippageBps: 10, preset: 'balanced', fallback: 'market' },
  { side: 'buy', size: new Decimal('0.0003'), deadlineSec: 300, maxSlippageBps: 10, preset: 'patient', fallback: 'market' },
  { side: 'sell', size: new Decimal('0.0003'), deadlineSec: 300, maxSlippageBps: 10, preset: 'patient', fallback: 'market' },
  { side: 'buy', size: new Decimal('0.0002'), deadlineSec: 60, maxSlippageBps: 5, preset: 'fast', fallback: 'market' },
  { side: 'sell', size: new Decimal('0.0002'), deadlineSec: 60, maxSlippageBps: 5, preset: 'fast', fallback: 'market' },
  { side: 'buy', size: new Decimal('0.0005'), deadlineSec: 180, maxSlippageBps: 20, preset: 'balanced', fallback: 'cancel' },
  { side: 'sell', size: new Decimal('0.0005'), deadlineSec: 180, maxSlippageBps: 20, preset: 'balanced', fallback: 'cancel' },
  { side: 'buy', size: new Decimal('0.00015'), deadlineSec: 240, maxSlippageBps: 10, preset: 'patient', fallback: 'market' },
  { side: 'sell', size: new Decimal('0.00015'), deadlineSec: 240, maxSlippageBps: 10, preset: 'fast', fallback: 'market' },
];

await exchange.start();
while (!exchange.market.isLive) await new Promise((r) => setTimeout(r, 200));
// Let the fill-rate model see a little flow first.
await new Promise((r) => setTimeout(r, 30_000));

const execs: Execution[] = [];
for (const p of runs) {
  execs.push(await manager.create({ ...p, mode: 'paper' }, null));
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`started ${execs.length} paper runs: ${execs.map((e) => e.id).join(' ')}`);
await Promise.all(execs.map((e) => (e.isFinished ? Promise.resolve() : new Promise<void>((r) => e.once('done', () => r())))));

for (const e of execs) {
  const r = e.report!;
  const actions = e.events.filter((x) => x.kind === 'action').length;
  console.log(
    [
      e.id,
      `${e.params.side} ${e.params.size} ${e.params.preset} ${e.params.deadlineSec}s ${e.params.fallback}`,
      `state=${e.state}`,
      `filled=${r.filledSize}`,
      `maker=${new Decimal(r.makerShare).mul(100).toFixed(0)}%`,
      `avg=${r.avgPrice ?? '-'}`,
      `arrival=${r.arrivalMid}`,
      `total=$${r.totalCost}`,
      `market=$${r.baselineCost ?? '-'}`,
      `saved=$${r.savings ?? '-'} (${r.savingsBps ?? '-'} bps)`,
      `actions=${actions}`,
      r.notes.length ? `notes=${r.notes.join(' / ')}` : '',
    ].join(' | '),
  );
}
console.log('\nSTATS ' + JSON.stringify(computeStats(store.all().filter((s) => execs.some((e) => e.id === s.id))).total));
exchange.stop();
process.exit(0);
