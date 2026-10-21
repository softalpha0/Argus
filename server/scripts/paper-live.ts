/**
 * Rests a paper buy at the best bid and a paper sell at the best ask on the live
 * book, and logs queue position and any fills.
 *
 *   npx tsx scripts/paper-live.ts [minutes] [sizeBtc]
 */
import pino from 'pino';
import { Decimal } from 'decimal.js';
import { loadConfig } from '../src/config.js';
import { L3Client } from '../src/strike/l3Client.js';
import { MarketModel } from '../src/model/MarketModel.js';
import { PaperVenue } from '../src/engine/PaperVenue.js';
import type { WorkingOrder } from '../src/engine/Venue.js';
import type { Side } from '../src/book/OrderBook.js';

const minutes = Number(process.argv[2] ?? 5);
const size = new Decimal(process.argv[3] ?? '0.0005');
const config = loadConfig();
const logger = pino({ level: 'info' });
const l3 = new L3Client({ symbol: config.symbol, wsUrl: config.hosts.l3Ws, restUrl: config.hosts.rest, logger: logger.child({ mod: 'l3' }) });
const model = new MarketModel(l3.book);
const venue = new PaperVenue(l3.book, { makerFee: config.makerFee, takerFee: config.takerFee });
let l3Fills = 0;
l3.on('update', (u, res) => {
  if (u.action === 'partial_fill' || u.action === 'full_fill') {
    l3Fills++;
    logger.info({ side: u.side, price: u.price, size: res.ok ? res.reduced?.toString() : '?', trade: u.trade_id }, 'L3 trade');
  }
  model.onUpdate(u, res);
  venue.onUpdate(u, res);
});
let paperFills = 0;
l3.on('synced', ({ book }) => {
  model.markStart(book.lastTimestamp);
  venue.onResync();
});

const working: Partial<Record<Side, WorkingOrder>> = {};
const placed: Partial<Record<Side, number>> = {};
let n = 0;
venue.on('fill', (f) => {
  paperFills++;
  const side = f.orderId.includes('buy') ? 'buy' : 'sell';
  const o = working[side];
  logger.info({ order: f.orderId, size: f.size.toString(), price: f.price.toString(), fee: f.fee.toString(), trade: f.tradeId, queueAheadWhenFilled: o ? venue.queuePosition(o).sizeAhead.toString() : undefined }, 'PAPER FILL');
});
venue.on('orderDone', (o, why) => {
  if (why === 'filled') logger.info({ order: o.id, waitedSec: ((Date.now() - o.placedAt) / 1000).toFixed(1) }, 'paper order fully filled');
});

async function tick() {
  if (!l3.isLive) return;
  for (const side of ['buy', 'sell'] as const) {
    const best = l3.book.best(side);
    if (!best) continue;
    const o = working[side];
    const stale = o && !o.done && !o.price.eq(best.price) && Date.now() - (placed[side] ?? 0) > 20_000;
    const crossed = o && !o.done && venue.isCrossed(o);
    if (crossed) logger.info({ side, price: o.price.toString() }, 'book moved through paper order without a trade; re-placing');
    if (!o || o.done || stale || crossed) {
      if (o && !o.done) await venue.cancel(o);
      try {
        working[side] = await venue.place({ side, price: best.price, size, clientId: `paper-${side}-${++n}` });
        placed[side] = Date.now();
        const q = venue.queuePosition(working[side]!);
        logger.info({ side, price: best.price.toString(), place: q.place, ahead: q.sizeAhead.toString(), expectedSec: model.expectedFillSeconds(side, best.price, size, Date.now()) }, 'placed paper order');
      } catch (e) {
        logger.warn({ side, err: (e as Error).message }, 'place failed');
      }
    }
  }
}

l3.start();
const t = setInterval(() => void tick(), 1000);
const status = setInterval(() => {
  for (const side of ['buy', 'sell'] as const) {
    const o = working[side];
    if (!o || o.done) continue;
    const q = venue.queuePosition(o);
    logger.info({ side, price: o.price.toString(), place: q.place, ahead: q.sizeAhead.toString(), filled: o.filled.toString(), ratePerSec: model.fillRate(side, Date.now()).toFixed(6) }, 'queue');
  }
}, 30_000);
setTimeout(() => {
  clearInterval(t);
  clearInterval(status);
  l3.stop();
  logger.info({ l3Fills, paperFills }, 'done');
  process.exit(0);
}, minutes * 60_000);
