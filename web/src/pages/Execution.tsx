import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { isFinished, type Execution as Ex } from '../lib/types';
import { btc, duration, time, usd } from '../lib/format';
import Ladder from '../components/Ladder';
import QueueMeter from '../components/QueueMeter';

export default function Execution({ id }: { id: string }) {
  const { executions, market } = useLive();
  const [initial, setInitial] = useState<Ex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    api<Ex>(`/api/executions/${id}`).then(setInitial).catch((e) => setError((e as Error).message));
  }, [id]);

  const ex = executions[id] ?? initial;
  if (error && !ex) return <p className="text-red-400">{error}</p>;
  if (!ex) return <p className="text-neutral-500">Loading…</p>;

  const filledPct = Math.min(100, (Number(ex.filled) / Number(ex.size)) * 100);
  const done = isFinished(ex);
  const q = ex.working?.queue;

  async function stop() {
    setStopping(true);
    await api(`/api/executions/${id}/cancel`, { method: 'POST' }).catch((e) => setError((e as Error).message));
    setStopping(false);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="grid min-w-0 content-start gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">
              <span className={ex.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{ex.side === 'buy' ? 'Buying' : 'Selling'}</span> {btc(ex.size)}
            </h1>
            <p className="text-sm text-neutral-400">
              {ex.mode === 'paper' ? 'Paper' : 'Live'} · limit {usd(ex.limitPrice, 0)} · arrival {usd(ex.arrivalMid, 1)} · {ex.preset}
            </p>
          </div>
          {done ? (
            <a href={`#/r/${ex.id}`} className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950">See report</a>
          ) : (
            <button onClick={() => void stop()} disabled={stopping} className="rounded-md border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900 disabled:opacity-50">
              {stopping ? 'Stopping…' : 'Stop and cancel'}
            </button>
          )}
        </header>

        <div className="grid gap-2 rounded-lg border border-neutral-800 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-mono tabular-nums">{ex.filled} / {ex.size} BTC filled</span>
            <span className="font-mono tabular-nums text-neutral-400">{done ? ex.state : `${duration(ex.timeLeftSec)} left`}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${filledPct}%` }} />
          </div>
          {ex.working && q && !done && (
            <div className="grid gap-1 pt-2">
              <span className="text-xs uppercase tracking-wider text-neutral-500">Resting at {usd(ex.working.price, 0)}</span>
              <QueueMeter place={q.place} sizeAhead={q.sizeAhead} estimating={q.estimating} etaSec={q.etaSec} />
            </div>
          )}
          {!ex.working && !done && <p className="pt-2 text-sm text-neutral-400">{ex.status ?? 'Deciding where to place…'}</p>}
          {ex.error && <p className="text-sm text-red-400">{ex.error}</p>}
        </div>

        <section className="grid gap-2">
          <h2 className="text-sm uppercase tracking-wider text-neutral-500">What Argus did</h2>
          <ol className="grid max-h-[24rem] gap-1 overflow-y-auto rounded-lg border border-neutral-800 p-3 text-sm">
            {[...ex.events].reverse().map((e, i) => (
              <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-2">
                <span className="font-mono text-xs text-neutral-500">{time(e.ts)}</span>
                <span className={e.kind === 'fill' ? 'text-emerald-300' : e.kind === 'error' ? 'text-red-400' : e.kind === 'warn' ? 'text-amber-300' : e.kind === 'action' ? 'text-neutral-100' : 'text-neutral-400'}>{e.text}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="grid min-w-0 content-start gap-3">
        <h2 className="text-sm uppercase tracking-wider text-neutral-500">Live order book</h2>
        {market?.book ? (
          <Ladder
            bids={market.book.bids}
            asks={market.book.asks}
            rows={10}
            ours={ex.working && !done ? { side: ex.side, price: ex.working.price, publicLinked: ex.mode === 'live' } : null}
          />
        ) : (
          <p className="text-sm text-neutral-500">Syncing…</p>
        )}
      </aside>
    </div>
  );
}
