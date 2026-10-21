import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { StatBucket, Stats as S } from '../lib/types';
import { pct, usd } from '../lib/format';

function Bucket({ title, b }: { title: string; b: StatBucket }) {
  const rows: [string, string][] = [
    ['Executions', `${b.executions} (${b.withFills} with fills)`],
    ['Volume', `${Number(b.volumeBtc).toFixed(5)} BTC · ${usd(b.notionalUsd, 2)}`],
    ['Filled as maker', pct(b.makerShare, 1)],
    ['Saved vs market', `${usd(b.savedUsd)} (${b.savedBps} bps)`],
    ['Argus fees', usd(b.argusFeesUsd)],
    ['Strike fees', usd(b.strikeFeesUsd)],
  ];
  return (
    <section className="grid gap-2 rounded-lg border border-neutral-800 p-4">
      <h2 className="text-sm uppercase tracking-wider text-neutral-500">{title}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-400">{k}</dt>
            <dd className="text-right font-mono tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SavingsChart({ series }: { series: S['series'] }) {
  if (series.length === 0) return <p className="text-sm text-neutral-500">No filled executions yet.</p>;
  const pts = series.slice(-40);
  const vals = pts.map((p) => Number(p.savedUsd));
  const max = Math.max(...vals.map(Math.abs), 0.0001);
  const W = 600, H = 160, pad = 24, bw = (W - pad * 2) / pts.length;
  const y0 = H / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-full" role="img" aria-label="Savings per execution">
      <line x1={pad} x2={W - pad} y1={y0} y2={y0} stroke="currentColor" className="text-neutral-700" />
      {pts.map((p, i) => {
        const v = Number(p.savedUsd);
        const h = (Math.abs(v) / max) * (H / 2 - pad);
        return (
          <rect key={i} x={pad + i * bw + 1} width={Math.max(bw - 2, 1)} y={v >= 0 ? y0 - h : y0} height={Math.max(h, 1)} fill={v >= 0 ? '#34d399' : '#fb7185'} opacity={p.mode === 'live' ? 1 : 0.6}>
            <title>{`${new Date(p.ts).toLocaleString()} · ${p.mode} · ${usd(v)}`}</title>
          </rect>
        );
      })}
      <text x={pad} y={14} fontSize="11" fill="currentColor" className="text-neutral-500">+{usd(max)}</text>
      <text x={pad} y={H - 4} fontSize="11" fill="currentColor" className="text-neutral-500">−{usd(max)}</text>
    </svg>
  );
}

export default function Stats() {
  const [s, setS] = useState<S | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<S>('/api/stats').then(setS).catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <p className="text-red-400">{error}</p>;
  if (!s) return <p className="text-neutral-500">Loading…</p>;
  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">Stats</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Bucket title="All" b={s.total} />
        <Bucket title="Live" b={s.live} />
        <Bucket title="Paper" b={s.paper} />
      </div>
      <section className="grid gap-2 rounded-lg border border-neutral-800 p-4 text-neutral-300">
        <h2 className="text-sm uppercase tracking-wider text-neutral-500">Saved vs a market order, per execution</h2>
        <SavingsChart series={s.series} />
        <p className="text-xs text-neutral-500">Green is saved, red is lost. Brighter bars are live runs.</p>
      </section>
    </div>
  );
}
