import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { go } from '../lib/router';
import { useWallet } from '../lib/wallet';
import { usd, time } from '../lib/format';
import Connect from './Connect';
import Ladder from '../components/Ladder';
import type { Execution } from '../lib/types';

interface Props {
  config: { liveConfigured: boolean; liveNotConfiguredReason: string | null; argusFeeBps: number; takerFee: string; makerFee: string };
}

const DEADLINES = [
  { label: '1 min', sec: 60 },
  { label: '5 min', sec: 300 },
  { label: '15 min', sec: 900 },
];

interface Recent {
  running: Execution[];
  recent: { id: string; mode: string; side: string; size: string; state: string; createdAt: number; savings: string | null; filled: string | null }[];
}

export default function Trade({ config }: Props) {
  const { market } = useLive();
  const { me } = useWallet();
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [size, setSize] = useState('0.0002');
  const [deadlineSec, setDeadlineSec] = useState(300);
  const [maxSlippageBps, setMaxSlippageBps] = useState(10);
  const [preset, setPreset] = useState('balanced');
  const [fallback, setFallback] = useState('market');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent | null>(null);

  useEffect(() => {
    api<Recent>('/api/executions').then(setRecent).catch(() => undefined);
  }, []);

  const mid = market?.mid ? Number(market.mid) : null;
  const usdEstimate = mid && Number(size) > 0 ? Number(size) * mid : null;
  const minNotional = market?.rules ? Number(market.rules.minNotional) : 10;
  const tooSmall = usdEstimate !== null && usdEstimate < minNotional;
  const liveBlocked = mode === 'live' && (!config.liveConfigured || !me);

  const takerPct = (Number(config.takerFee) * 100).toFixed(3);
  const makerPct = (Math.abs(Number(config.makerFee)) * 100).toFixed(3);
  const feeExample = useMemo(() => {
    const n = usdEstimate ?? 0;
    return { market: n * Number(config.takerFee), argus: n * (Number(config.makerFee) + config.argusFeeBps / 10000) };
  }, [usdEstimate, config]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const ex = await api<Execution>('/api/executions', { method: 'POST', json: { mode, side, size, deadlineSec, maxSlippageBps, preset, fallback } });
      go(`/x/${ex.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const seg = (on: boolean) => `flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${on ? 'bg-neutral-100 text-neutral-950' : 'text-neutral-400 hover:text-neutral-200'}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="grid min-w-0 content-start gap-6">
        <form onSubmit={submit} className="grid gap-4 rounded-lg border border-ink-700 p-4">
          <div className="flex gap-1 rounded-lg bg-ink-800 p-1" role="group" aria-label="Mode">
            <button type="button" className={seg(mode === 'paper')} onClick={() => setMode('paper')}>Paper</button>
            <button type="button" className={seg(mode === 'live')} onClick={() => setMode('live')}>Live</button>
          </div>
          <p className="text-sm text-neutral-400">
            {mode === 'paper'
              ? 'Paper mode runs on the live Strike book with a pretend order. It fills only when real trades reach it. No wallet needed.'
              : 'Live mode places real post-only orders on Strike from your connected account.'}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <span className="text-xs uppercase tracking-wider text-neutral-500">Side</span>
              <div className="flex gap-1 rounded-lg bg-ink-800 p-1">
                <button type="button" className={`${seg(side === 'buy')} ${side === 'buy' ? '!bg-maker !text-neutral-950' : ''}`} onClick={() => setSide('buy')}>Buy</button>
                <button type="button" className={`${seg(side === 'sell')} ${side === 'sell' ? '!bg-rose-500 !text-neutral-950' : ''}`} onClick={() => setSide('sell')}>Sell</button>
              </div>
            </div>
            <label className="grid gap-1" htmlFor="size">
              <span className="text-xs uppercase tracking-wider text-neutral-500">Size (BTC)</span>
              <input id="size" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value.trim())} className="rounded-md border border-ink-600 bg-ink-800 px-3 py-2 font-mono tabular-nums" />
              <span className={`text-xs ${tooSmall ? 'text-amber-400' : 'text-neutral-500'}`}>
                {usdEstimate !== null ? `≈ ${usd(usdEstimate, 2)}` : '—'}
                {tooSmall ? ` · Strike's minimum is $${minNotional}` : ''}
              </span>
            </label>
          </div>

          <div className="grid gap-1">
            <span className="text-xs uppercase tracking-wider text-neutral-500">Finish within</span>
            <div className="flex gap-1 rounded-lg bg-ink-800 p-1">
              {DEADLINES.map((d) => (
                <button key={d.sec} type="button" className={seg(deadlineSec === d.sec)} onClick={() => setDeadlineSec(d.sec)}>{d.label}</button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid min-w-0 gap-1" htmlFor="slip">
              <span className="text-xs uppercase tracking-wider text-neutral-500">Max price move</span>
              <div className="flex items-center gap-2">
                <input id="slip" type="number" min={1} max={500} value={maxSlippageBps} onChange={(e) => setMaxSlippageBps(Number(e.target.value))} className="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 font-mono" />
                <span className="text-sm text-neutral-500">bps</span>
              </div>
              <span className="text-xs text-neutral-500">{(maxSlippageBps / 100).toFixed(2)}% from the price now</span>
            </label>
            <label className="grid min-w-0 gap-1" htmlFor="preset">
              <span className="text-xs uppercase tracking-wider text-neutral-500">Style</span>
              <select id="preset" value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full min-w-0 rounded-md border border-ink-600 bg-ink-800 px-3 py-2">
                <option value="patient">Patient (wait in line)</option>
                <option value="balanced">Balanced</option>
                <option value="fast">Fast (jump the line sooner)</option>
              </select>
            </label>
            <label className="grid min-w-0 gap-1" htmlFor="fallback">
              <span className="text-xs uppercase tracking-wider text-neutral-500">If time runs out</span>
              <select id="fallback" value={fallback} onChange={(e) => setFallback(e.target.value)} className="w-full min-w-0 rounded-md border border-ink-600 bg-ink-800 px-3 py-2">
                <option value="market">Finish with a market order</option>
                <option value="cancel">Cancel the rest</option>
              </select>
            </label>
          </div>

          <div className="rounded-md bg-ink-800 p-3 text-sm text-neutral-300">
            Market orders pay <b className="font-mono">{takerPct}%</b>. {Number(config.makerFee) < 0 ? (
              <>Maker orders earn <b className="font-mono">{makerPct}%</b> back.</>
            ) : Number(config.makerFee) > 0 ? (
              <>Maker orders pay <b className="font-mono">{makerPct}%</b>.</>
            ) : (
              <>Maker orders pay <b className="font-mono">no fee</b>.</>
            )} Argus charges <b className="font-mono">{(config.argusFeeBps / 100).toFixed(2)}%</b>.
            {usdEstimate ? (
              <span className="mt-1 block font-mono text-xs text-neutral-400">
                On this order: market fee {usd(feeExample.market)} vs {usd(feeExample.argus)} if it fills as maker.
              </span>
            ) : null}
          </div>

          {liveBlocked && <p className="text-sm text-amber-400">{!config.liveConfigured ? config.liveNotConfiguredReason : 'Connect your wallet below to trade live.'}</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={busy || liveBlocked || !market?.live} className={`rounded-md px-4 py-3 font-medium text-neutral-950 disabled:opacity-40 ${side === 'buy' ? 'bg-maker hover:bg-[#4ce3ae]' : 'bg-rose-500 hover:bg-rose-400'}`}>
            {busy ? 'Starting…' : `${mode === 'live' ? 'Start live' : 'Start paper'} ${side} of ${size || '0'} BTC`}
          </button>
          {!market?.live && <p className="text-xs text-neutral-500">Waiting for the order book to sync…</p>}
        </form>

        <Connect liveConfigured={config.liveConfigured} reason={config.liveNotConfiguredReason} />

        {recent && (recent.running.length > 0 || recent.recent.length > 0) && (
          <section className="grid gap-2">
            <h2 className="text-sm uppercase tracking-wider text-neutral-500">Recent runs</h2>
            <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700 text-sm">
              {[...recent.running.map((e) => ({ id: e.id, mode: e.mode, side: e.side, size: e.size, state: e.state, createdAt: e.createdAt, savings: null as string | null })), ...recent.recent].slice(0, 10).map((r) => (
                <li key={r.id}>
                  <a href={r.state === 'working' ? `#/x/${r.id}` : `#/r/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-ink-800">
                    <span className="font-mono text-xs text-neutral-500">{time(r.createdAt)}</span>
                    <span className={r.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{r.side} {r.size}</span>
                    <span className="rounded bg-neutral-800 px-1.5 text-xs">{r.mode}</span>
                    <span className="text-neutral-400">{r.state}</span>
                    <span className="font-mono tabular-nums">{r.savings !== null ? `saved ${usd(r.savings)}` : ''}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="grid min-w-0 content-start gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm uppercase tracking-wider text-neutral-500">BTC-USD order book</h2>
          <span className="font-mono text-sm tabular-nums">{mid ? usd(mid, 1) : '—'}</span>
        </div>
        {market?.book ? <Ladder bids={market.book.bids} asks={market.book.asks} rows={10} /> : <p className="text-sm text-neutral-500">Syncing order book…</p>}
        <p className="text-xs text-neutral-500">Every bar is one resting order, in true queue order. That's Strike's L3 feed.</p>
      </aside>
    </div>
  );
}
