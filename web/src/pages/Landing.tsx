import { useLive } from '../lib/live';
import { price, usd } from '../lib/format';
import type { BookLevel } from '../lib/types';

function QueueHero({ level, side }: { level: BookLevel | undefined; side: 'buy' | 'sell' }) {
  const orders = level?.orders.slice(0, 14) ?? [];
  const total = orders.reduce((s, o) => s + Number(o.size), 0) || 1;
  return (
    <div className="panel relative overflow-hidden p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">Strike BTC-USD · one {side === 'buy' ? 'bid' : 'ask'} level, right now</span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-maker">
          <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-maker" /> L3 live
        </span>
      </div>
      <p className="mt-3 font-mono text-3xl font-semibold num">{level ? `$${price(level.price)}` : '—'}</p>
      <p className="text-sm text-neutral-400">{level ? `${level.orders.length} ${level.orders.length === 1 ? 'order' : 'orders'} waiting at this price, in true queue order` : 'Syncing the order book…'}</p>
      <div className="mt-5 flex h-10 w-full gap-[3px]" aria-label="Orders in the queue">
        {orders.map((o, i) => (
          <div
            key={o.id}
            title={`#${i + 1} · ${o.size} BTC`}
            className={`h-full rounded-[3px] ${side === 'buy' ? 'bg-maker/70' : 'bg-taker/70'} ${i === 0 ? 'ring-1 ring-white/40' : ''}`}
            style={{ flexGrow: Math.max(Number(o.size) / total, 0.04) }}
          />
        ))}
        <div className="h-full min-w-[3.25rem] rounded-[3px] border border-dashed border-queue bg-queue/15 px-1 text-center font-mono text-[10px] leading-10 text-queue">you</div>
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11px] text-neutral-500">
        <span>front of the line</span>
        <span>#{orders.length + 1} in line</span>
      </div>
      <p className="mt-4 border-t border-ink-700 pt-4 text-sm text-neutral-300">
        Most exchanges hide this. Strike publishes it. Argus reads every order ahead of you to decide whether to join the line, jump it by one tick, or move.
      </p>
    </div>
  );
}

function FeeCard() {
  const rows: [string, string, string][] = [
    ['Strike fee', '$5.00 paid', '$0.50 rebate'],
    ['Argus fee', '—', '$2.00'],
    ['Net fees', '$5.00', '$1.50'],
  ];
  return (
    <div className="panel p-5">
      <span className="eyebrow">A $10,000 BTC buy, filled as maker</span>
      <div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-x-6 gap-y-2 text-sm">
        <span />
        <span className="text-right text-neutral-500">Market order</span>
        <span className="text-right text-neutral-500">Through Argus</span>
        {rows.map(([k, a, b]) => (
          <div key={k} className="contents">
            <span className="text-neutral-300">{k}</span>
            <span className="text-right font-mono num text-taker">{a}</span>
            <span className="text-right font-mono num text-maker">{b}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 font-mono text-2xl font-semibold text-maker num">You keep $3.50</p>
      <p className="text-xs text-neutral-500">3.5 bps before spread. Every report also counts price moves while you wait.</p>
    </div>
  );
}

const STEPS: [string, string][] = [
  ['Connect once', 'Sign one message in Phantom or a Cardano wallet. Argus gets a trade-only key through Strike Builder Connect. It can place and cancel orders. It can never withdraw.'],
  ['Say what you want', 'Buy 0.002 BTC, finish within 5 minutes, never pay more than 0.10% above the price now.'],
  ['Argus picks a spot', 'It reads the queue order by order and joins the best bid or improves it by one tick, based on how long the line is and how fast it fills.'],
  ['It waits as a maker', 'Orders are post-only, so they can never take liquidity by accident. You watch your place in line live.'],
  ['Deadline safety net', 'If time runs out, Argus finishes the rest with a market order, or cancels, your choice. Then you get a report with every number.'],
];

const FEATURES: [string, string][] = [
  ['Queue-aware placement', 'Join or jump the line from real queue length and fill rate, never from guesses.'],
  ['Always post-only', 'Every resting order is maker-only. A cross is rejected, not filled.'],
  ['Paper mode on the real queue', 'A pretend order joins the back of the live line and fills only when real trades reach it.'],
  ['Fairness receipt', 'Each live fill is checked: best price, first in line, and on the public tape by trade ID.'],
  ['Builder Codes built in', 'Every order carries the argus code, so the fee shows on Strike, order by order.'],
  ['Deposit and withdraw', 'Fund your Strike account and withdraw back to your own wallet without leaving Argus.'],
];

export default function Landing() {
  const { market } = useLive();
  // Show the busiest of the top bid levels so the queue is visible even when the best bid has one order.
  const showcase = market?.book?.bids.slice(0, 5).reduce<BookLevel | undefined>((a, l) => (!a || l.orders.length > a.orders.length ? l : a), undefined);
  const orders = market?.book ? [...market.book.bids, ...market.book.asks].reduce((s, l) => s + l.orders.length, 0) : null;

  return (
    <div className="grid gap-24 pb-10">
      <section className="relative grid items-start gap-10 pt-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="hero-grid pointer-events-none absolute -inset-x-10 -top-10 h-[34rem]" aria-hidden />
        <div className="relative grid gap-6 animate-rise">
          <span className="eyebrow text-maker">Built on Strike Finance · L3 order book</span>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Get paid to trade
            <br />
            on Strike.
          </h1>
          <p className="max-w-[34rem] text-lg leading-8 text-neutral-300">
            Market orders pay <b className="font-mono font-medium text-taker">0.050%</b>. Maker orders earn <b className="font-mono font-medium text-maker">0.005%</b> back. Argus works your order as a maker, using Strike's live queue data to decide where to wait in line and when to move.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="#/trade" className="btn-primary">Try it in paper mode</a>
            <a href="#/docs" className="btn-ghost">How it works</a>
          </div>
          <dl className="mt-2 grid max-w-lg grid-cols-3 gap-4 border-t border-ink-700 pt-5">
            <div>
              <dt className="eyebrow">BTC-USD mid</dt>
              <dd className="mt-1 font-mono text-lg num">{market?.mid ? usd(market.mid, 1) : '—'}</dd>
            </div>
            <div>
              <dt className="eyebrow">Orders on book</dt>
              <dd className="mt-1 font-mono text-lg num">{orders ?? '—'}</dd>
            </div>
            <div>
              <dt className="eyebrow">Spread</dt>
              <dd className="mt-1 font-mono text-lg num">{market?.spread ? usd(market.spread, Number(market.spread) < 1 ? 1 : 0) : '—'}</dd>
            </div>
          </dl>
        </div>
        <div className="relative grid gap-4">
          <QueueHero level={showcase} side="buy" />
          <FeeCard />
        </div>
      </section>

      <section className="grid gap-8">
        <div className="grid gap-2">
          <span className="eyebrow">How it works</span>
          <h2 className="text-3xl font-semibold tracking-tight">Five steps, one signature.</h2>
        </div>
        <ol className="grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 md:grid-cols-5">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="grid content-start gap-2 bg-ink-900 p-5">
              <span className="font-mono text-sm text-maker">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="font-medium">{t}</h3>
              <p className="text-sm leading-6 text-neutral-400">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-8">
        <div className="grid gap-2">
          <span className="eyebrow">What's inside</span>
          <h2 className="text-3xl font-semibold tracking-tight">A maker engine that shows its work.</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([t, d]) => (
            <div key={t} className="grid content-start gap-2 border-t border-ink-600 pt-4">
              <h3 className="font-medium">{t}</h3>
              <p className="text-sm leading-6 text-neutral-400">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <span className="eyebrow">For Strike</span>
          <h2 className="text-3xl font-semibold tracking-tight">More volume, deeper books, fees from day one.</h2>
          <p className="max-w-prose leading-7 text-neutral-400">
            Every Argus execution is real Strike volume that rests on the book as liquidity before it fills. Paper mode lets anyone see how Strike's book behaves before they deposit.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700">
          {[
            ['Volume', 'Every execution trades on Strike'],
            ['Liquidity', 'Orders rest as maker and tighten the spread'],
            ['Fees', 'The argus builder code on every order'],
            ['New users', 'Paper mode needs no wallet and no funds'],
          ].map(([k, v]) => (
            <div key={k} className="bg-ink-900 p-5">
              <dt className="font-medium">{k}</dt>
              <dd className="mt-1 text-sm text-neutral-400">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:p-8">
        <div className="grid gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Your keys, your withdrawals.</h2>
          <p className="max-w-prose text-neutral-400">
            Argus's key for your account can trade but cannot withdraw. Withdrawals always need your own wallet's signature and Strike sends them only to the wallet you connected. Stored keys are encrypted with AES-256-GCM, and you can revoke Argus in Strike's app at any time.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <a href="#/trade" className="btn-primary">Start trading</a>
          <a href="#/docs/security" className="btn-ghost">Security details</a>
        </div>
      </section>
    </div>
  );
}
