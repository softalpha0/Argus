/**
 * Soak test against the live Strike feed.
 *
 *   npx tsx scripts/soak.ts [minutes]
 *
 * Keeps the L3 book in sync, and every 60 s rebuilds an independent copy from a
 * fresh snapshot plus recorded updates, then checks the two books match order by
 * order. Also checks whether L3 trade_id lines up with the trade stream's t.
 */
import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { L3Client } from '../src/strike/l3Client.js';
import { TapeClient } from '../src/strike/tapeClient.js';
import { OrderBook, type L3Snapshot, type L3Update } from '../src/book/OrderBook.js';
import { fetchSymbolRules } from '../src/strike/exchangeInfo.js';

const minutes = Number(process.argv[2] ?? 10);
const config = loadConfig();
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const rules = await fetchSymbolRules(config.hosts.marketRest, config.symbol);
logger.info({ tick: rules.tickSize.toString(), minQty: rules.minQty.toString(), minNotional: rules.minNotional.toString() }, 'exchange info');

const l3 = new L3Client({ symbol: config.symbol, wsUrl: config.hosts.l3Ws, restUrl: config.hosts.rest, logger });
const tape = new TapeClient({ symbol: config.symbol, wsUrl: config.hosts.priceWs, logger });

// Recent updates, so a snapshot taken at any recent sequence can be rolled forward.
const history: L3Update[] = [];
l3.on('update', (u) => {
  history.push(u);
  if (history.length > 50_000) history.splice(0, 10_000);
});
l3.on('synced', () => (history.length = 0));

// trade_id vs tape t.
const l3Trades = new Map<number, { price: string; size: number; ts: number }>();
l3.on('update', (u) => {
  if ((u.action === 'partial_fill' || u.action === 'full_fill') && u.trade_id !== undefined) {
    const prev = l3Trades.get(u.trade_id);
    const sz = -Number(u.delta_size);
    l3Trades.set(u.trade_id, { price: u.price!, size: (prev?.size ?? 0) + sz, ts: u.timestamp });
  }
});
let tapeMatched = 0;
let tapeUnmatched = 0;
let tapeSizeMismatch = 0;
const unmatchedSamples: unknown[] = [];
tape.on('trade', (t) => {
  // Give L3 a moment to deliver the matching fill events.
  setTimeout(() => {
    const m = l3Trades.get(t.id);
    if (!m) {
      tapeUnmatched++;
      if (unmatchedSamples.length < 5) unmatchedSamples.push({ t: t.id, p: t.price.toString(), q: t.size.toString() });
      return;
    }
    tapeMatched++;
    if (Math.abs(m.size - t.size.toNumber()) > 1e-9) tapeSizeMismatch++;
  }, 2000);
});

let checks = 0;
let checksOk = 0;
const mismatches: string[] = [];

function compare(a: OrderBook, b: OrderBook): string | null {
  const ja = a.toJSON();
  const jb = b.toJSON();
  for (const side of ['bids', 'asks'] as const) {
    if (ja[side].length !== jb[side].length) return `${side}: ${ja[side].length} levels vs ${jb[side].length}`;
    for (let i = 0; i < ja[side].length; i++) {
      const x = ja[side][i]!;
      const y = jb[side][i]!;
      if (x.price !== y.price) return `${side}[${i}] price ${x.price} vs ${y.price}`;
      if (JSON.stringify(x.orders) !== JSON.stringify(y.orders)) return `${side} ${x.price}: FIFO differs`;
    }
  }
  return null;
}

async function verify() {
  if (!l3.isLive) return;
  const res = await fetch(`${config.hosts.rest}/v2/l3/snapshot?symbol=${config.symbol}`);
  const snap = (await res.json()) as L3Snapshot;
  // Wait until the live book has reached the snapshot's sequence.
  const deadline = Date.now() + 10_000;
  while (l3.book.lastSequence < snap.last_sequence && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!l3.isLive) return;
  const target = l3.book.lastSequence;
  const shadow = new OrderBook(config.symbol);
  shadow.loadSnapshot(snap);
  const start = history.findIndex((u) => u.sequence === snap.last_sequence + 1);
  if (snap.last_sequence < target && start < 0) {
    logger.warn({ snap: snap.last_sequence, live: target }, 'verify: history does not reach back far enough, skipping');
    return;
  }
  for (let i = Math.max(start, 0); start >= 0 && i < history.length && history[i]!.sequence <= target; i++) {
    const r = shadow.apply(history[i]!);
    if (!r.ok) {
      mismatches.push(`shadow apply failed: ${r.error}`);
      return;
    }
  }
  checks++;
  const diff = shadow.lastSequence === target ? compare(l3.book, shadow) : `shadow at ${shadow.lastSequence}, live at ${target}`;
  if (diff) mismatches.push(`seq ${target}: ${diff}`);
  else checksOk++;
  logger.info({ snapSeq: snap.last_sequence, liveSeq: target, replayed: target - snap.last_sequence, orders: l3.book.orderCount(), ok: !diff, diff }, 'verify: book vs fresh snapshot');
}

l3.start();
tape.start();
const verifyTimer = setInterval(() => void verify().catch((e) => logger.warn({ err: String(e) }, 'verify failed')), 60_000);
const progress = setInterval(() => {
  const b = l3.book;
  logger.info(
    { state: l3.state, seq: b.lastSequence, updates: l3.stats.updatesApplied, resyncs: l3.stats.resyncs, bid: b.bestBid()?.key, ask: b.bestAsk()?.key, tapeTrades: tape.tradesSeen },
    'progress',
  );
}, 30_000);

setTimeout(() => {
  clearInterval(verifyTimer);
  clearInterval(progress);
  l3.stop();
  tape.stop();
  const summary = {
    minutes,
    updatesApplied: l3.stats.updatesApplied,
    syncs: l3.stats.syncs,
    resyncs: l3.stats.resyncs,
    resyncReasons: l3.stats.resyncReasons,
    bookChecks: `${checksOk}/${checks} matched a fresh snapshot`,
    mismatches,
    tape: { trades: tape.tradesSeen, reconnects: tape.reconnects, matchedL3TradeId: tapeMatched, unmatched: tapeUnmatched, sizeMismatch: tapeSizeMismatch, unmatchedSamples },
  };
  console.log('\nSOAK SUMMARY\n' + JSON.stringify(summary, null, 2));
  process.exit(mismatches.length || l3.stats.resyncs > l3.stats.syncs ? 1 : 0);
}, minutes * 60_000);
