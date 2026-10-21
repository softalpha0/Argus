import { Decimal } from 'decimal.js';
import type { StoredExecution } from './Store.js';

interface Bucket {
  executions: number;
  withFills: number;
  volumeBtc: Decimal;
  notionalUsd: Decimal;
  makerBtc: Decimal;
  savedUsd: Decimal;
  argusFeesUsd: Decimal;
  strikeFeesUsd: Decimal;
}

const empty = (): Bucket => ({
  executions: 0,
  withFills: 0,
  volumeBtc: new Decimal(0),
  notionalUsd: new Decimal(0),
  makerBtc: new Decimal(0),
  savedUsd: new Decimal(0),
  argusFeesUsd: new Decimal(0),
  strikeFeesUsd: new Decimal(0),
});

const out = (b: Bucket) => ({
  executions: b.executions,
  withFills: b.withFills,
  volumeBtc: b.volumeBtc.toString(),
  notionalUsd: b.notionalUsd.toFixed(2),
  makerShare: b.volumeBtc.gt(0) ? b.makerBtc.div(b.volumeBtc).toDecimalPlaces(4).toString() : '0',
  savedUsd: b.savedUsd.toFixed(4),
  savedBps: b.notionalUsd.gt(0) ? b.savedUsd.div(b.notionalUsd).mul(10_000).toDecimalPlaces(2).toString() : '0',
  argusFeesUsd: b.argusFeesUsd.toFixed(4),
  strikeFeesUsd: b.strikeFeesUsd.toFixed(4),
});

export function computeStats(execs: StoredExecution[]) {
  const all = empty();
  const byMode = { paper: empty(), live: empty() };
  const series: { ts: number; mode: string; notionalUsd: string; savedUsd: string; makerShare: string }[] = [];
  for (const e of execs) {
    const r = e.report as Record<string, string | null> | null | undefined;
    for (const b of [all, byMode[e.mode]]) {
      b.executions++;
      if (!r || new Decimal(r.filledSize ?? 0).isZero()) continue;
      b.withFills++;
      b.volumeBtc = b.volumeBtc.plus(r.filledSize!);
      b.notionalUsd = b.notionalUsd.plus(r.notional!);
      b.makerBtc = b.makerBtc.plus(r.makerSize ?? 0);
      b.savedUsd = b.savedUsd.plus(r.savings ?? 0);
      b.argusFeesUsd = b.argusFeesUsd.plus(r.argusFee ?? 0);
      b.strikeFeesUsd = b.strikeFeesUsd.plus(r.strikeFees ?? 0);
    }
    if (r && !new Decimal(r.filledSize ?? 0).isZero()) {
      series.push({ ts: e.endedAt ?? e.createdAt, mode: e.mode, notionalUsd: new Decimal(r.notional!).toFixed(2), savedUsd: new Decimal(r.savings ?? 0).toFixed(4), makerShare: r.makerShare ?? '0' });
    }
  }
  return { total: out(all), paper: out(byMode.paper), live: out(byMode.live), series };
}
