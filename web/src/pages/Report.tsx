import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ExecEvent, ExecFill, Report as R } from '../lib/types';
import { btc, pct, time, usd } from '../lib/format';
import SavingsBreakdown from '../components/SavingsBreakdown';

interface ReportResponse {
  id: string;
  mode: string;
  side: 'buy' | 'sell';
  size: string;
  state: string;
  createdAt: number;
  endedAt: number;
  arrivalMid: string;
  limitPrice: string;
  error: string | null;
  argusFeeBps: number;
  report: R;
  fills: ExecFill[];
  events: ExecEvent[];
  audit?: { orders?: { clientOrderId: string; id?: number; status?: string; builder?: { Code: string; FeeBps: number } | null; error?: string }[] } | null;
}

const Check = ({ v }: { v?: string }) =>
  v === 'pass' ? <span className="text-emerald-400">✓</span> : v === 'fail' ? <span className="text-amber-400">✗</span> : <span className="text-neutral-500">–</span>;

export default function Report({ id }: { id: string }) {
  const [r, setR] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const load = () =>
      api<ReportResponse>(`/api/reports/${id}`)
        .then(setR)
        .catch((e) => {
          if (/still running/.test((e as Error).message)) timer = window.setTimeout(load, 1500);
          else setError((e as Error).message);
        });
    void load();
    return () => window.clearTimeout(timer);
  }, [id]);

  if (error) return <p className="text-red-400">{error}</p>;
  if (!r) return <p className="text-neutral-500">Loading report…</p>;
  const rep = r.report;
  const saved = rep.savings !== null ? Number(rep.savings) : null;
  const live = r.mode === 'live';

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">
          {r.side === 'buy' ? 'Bought' : 'Sold'} {btc(rep.filledSize)} <span className="text-neutral-500">of {btc(r.size)}</span>
        </h1>
        <p className="text-sm text-neutral-400">
          {live ? 'Live' : 'Paper'} · {time(r.createdAt)}–{time(r.endedAt)} · {r.state}
          {r.error ? ` · ${r.error}` : ''}
        </p>
      </header>

      <section className="grid gap-3 rounded-lg border border-ink-700 p-5 sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-neutral-500">Compared with a market order at the start</p>
          <p className={`mt-1 font-mono text-3xl tabular-nums ${saved === null ? 'text-neutral-400' : saved >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {saved === null ? '—' : `${saved >= 0 ? 'saved ' : 'lost '}${usd(Math.abs(saved))}`}
          </p>
          <p className="font-mono text-sm text-neutral-400">{rep.savingsBps !== null ? `${Number(rep.savingsBps).toFixed(2)} bps of notional` : ''}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-neutral-500">Filled as maker</p>
          <p className="mt-1 font-mono text-3xl tabular-nums">{pct(rep.makerShare)}</p>
          <p className="font-mono text-sm text-neutral-400">avg {rep.avgPrice ? usd(rep.avgPrice, 2) : '—'}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-neutral-500">Fees</p>
          <p className="mt-1 font-mono text-sm tabular-nums">Strike {usd(rep.strikeFees)}</p>
          <p className="font-mono text-sm tabular-nums">Argus {usd(rep.argusFee)}</p>
        </div>
        {rep.notes.length > 0 && <ul className="col-span-full list-disc pl-5 text-sm text-neutral-400">{rep.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <p className="col-span-full text-xs text-neutral-500">Price can move while an order waits. This comparison includes that move, not just fees.</p>
      </section>

      <section className="grid gap-2">
        <h2 className="text-sm uppercase tracking-wider text-neutral-500">The math, step by step</h2>
        <SavingsBreakdown steps={rep.steps} />
      </section>

      <section className="grid gap-2">
        <h2 className="text-sm uppercase tracking-wider text-neutral-500">Fills</h2>
        {r.fills.length === 0 ? (
          <p className="text-sm text-neutral-400">No fills.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-ink-700">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-normal">Time</th>
                  <th className="px-3 py-2 font-normal">Size</th>
                  <th className="px-3 py-2 font-normal">Price</th>
                  <th className="px-3 py-2 font-normal">Type</th>
                  <th className="px-3 py-2 font-normal">Fee</th>
                  {live && <th className="px-3 py-2 font-normal" title="Best price · First in line · On the tape">Checks</th>}
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {r.fills.map((f, i) => (
                  <tr key={i} className="border-t border-ink-700">
                    <td className="px-3 py-2 text-neutral-400">{time(f.ts)}</td>
                    <td className="px-3 py-2">{f.size}</td>
                    <td className="px-3 py-2">{usd(f.price, 0)}</td>
                    <td className="px-3 py-2">{f.isMaker ? <span className="text-emerald-400">maker</span> : <span className="text-amber-300">taker</span>}</td>
                    <td className="px-3 py-2">{usd(f.fee)}</td>
                    {live && (
                      <td className="px-3 py-2 font-sans text-xs" title={f.checks?.note}>
                        {f.isMaker ? (
                          f.checks?.pending ? 'checking…' : (
                            <span className="inline-flex gap-3">
                              <span>Best price <Check v={f.checks?.bestPrice} /></span>
                              <span>First in line <Check v={f.checks?.firstInLine} /></span>
                              <span>On tape <Check v={f.checks?.onTape} /></span>
                            </span>
                          )
                        ) : (
                          <span className="text-neutral-500">market fallback</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {live && <p className="text-xs text-neutral-500">A ✗ means a check failed. See the data. It does not by itself mean anything went wrong.</p>}
      </section>

      {live && r.audit?.orders && r.audit.orders.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-sm uppercase tracking-wider text-neutral-500">Orders as Strike reports them</h2>
          <div className="overflow-x-auto rounded-lg border border-ink-700">
            <table className="w-full min-w-[30rem] font-mono text-xs">
              <thead className="text-left text-[11px] uppercase tracking-wider text-neutral-500">
                <tr><th className="px-3 py-2 font-normal">Order ID</th><th className="px-3 py-2 font-normal">Status</th><th className="px-3 py-2 font-normal">Builder</th></tr>
              </thead>
              <tbody>
                {r.audit.orders.map((o) => (
                  <tr key={o.clientOrderId} className="border-t border-ink-700">
                    <td className="px-3 py-2">{o.id ?? o.clientOrderId}</td>
                    <td className="px-3 py-2">{o.status ?? o.error}</td>
                    <td className="px-3 py-2">{o.builder ? `${o.builder.Code} · ${o.builder.FeeBps} bps` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <details className="rounded-lg border border-ink-700 p-3 text-sm">
        <summary className="cursor-pointer text-neutral-400">Decision log ({r.events.length})</summary>
        <ol className="mt-2 grid gap-1">
          {r.events.map((e, i) => (
            <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-2"><span className="font-mono text-xs text-neutral-500">{time(e.ts)}</span><span>{e.text}</span></li>
          ))}
        </ol>
      </details>
    </div>
  );
}
