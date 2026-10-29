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
        <div className="h-full min-w-[3.25rem] rounded-[3px] border border-dashed border-queue bg-queue/15 px-1 text-center font-mono text-[10px] leading-10 text-queue">agent</div>
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11px] text-neutral-500">
        <span>front of the line</span>
        <span>#{orders.length + 1} in line</span>
      </div>
      <p className="mt-4 border-t border-ink-700 pt-4 text-sm text-neutral-300">
        Strike publishes every resting order in queue order. Argus reads the whole line before it places your agent's order, then decides whether to join it, improve by one tick, or move.
      </p>
    </div>
  );
}

const k = 'text-[#8fb8ff]';
const s = 'text-maker';
const n = 'text-queue';
const c = 'text-neutral-500';

function CodeCard() {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-taker" />
        <span className="h-2.5 w-2.5 rounded-full bg-queue" />
        <span className="h-2.5 w-2.5 rounded-full bg-maker" />
        <span className="ml-3 font-mono text-[11px] text-neutral-500">your agent → Argus</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-6 text-neutral-200">
        <span className={k}>POST</span> /v1/executions{'\n'}
        {'{ '}<span className={s}>"side"</span>: <span className={s}>"buy"</span>, <span className={s}>"size"</span>: <span className={n}>"0.002"</span>,{'\n'}
        {'  '}<span className={s}>"deadlineSec"</span>: <span className={n}>300</span>, <span className={s}>"maxSlippageBps"</span>: <span className={n}>10</span>{' }'}{'\n'}
        {'\n'}
        <span className={c}>event: fill    </span>0.0015 @ 79,735.8 · <span className={s}>maker</span>{'\n'}
        <span className={c}>event: receipt </span><span className={s}>argus.receipt.v1</span>{'\n'}
        <span className={c}>  saved vs market order: </span><span className={s}>18 bps</span>
      </pre>
    </div>
  );
}

const STEPS: [string, string][] = [
  ['Connect once', 'Sign one message with a Solana or Cardano wallet. Argus gets a trade-only key through Strike Builder Connect: it can place and cancel orders, never withdraw.'],
  ['Create an API key', 'Give your agent its own key with a per-order and a daily limit. Revoke it any time; running orders stop with it.'],
  ['Your agent sends an order', 'One call: side, size, deadline and the most it will pay over the price now. Retries are safe with an Idempotency-Key.'],
  ['Argus works it as a maker', 'Post-only orders, placed from the live queue. It moves when outbid, never past the limit, and finishes at the deadline if it must.'],
  ['Your agent gets a receipt', 'Every fill, fee and the saving against a market order at arrival, plus fairness checks on each live fill.'],
];

const FEATURES: [string, string][] = [
  ['Queue-aware placement', 'Joins or improves the best price from real queue length and fill rate, read order by order from the L3 book.'],
  ['Always post-only', 'Resting orders can never take liquidity by accident. A cross is rejected, not filled.'],
  ['Limits per key', 'Per-order and daily USD caps on live orders, checked before anything reaches the exchange.'],
  ['Live event stream', 'Server-Sent Events with the order state, place in line, every fill, then the final receipt.'],
  ['Verifiable receipts', 'A versioned JSON record per run, with the venue’s own order records and per-fill fairness checks.'],
  ['Paper mode on the real book', 'Test strategies against the live queue: a paper order fills only when real trades reach it.'],
];

const LIVE = ['Execution API with streaming and receipts', 'MCP server: agents trade in plain language', 'Signed webhooks', 'API keys with per-order and daily limits', 'Solana and Cardano wallets', 'Paper mode on the live order book'];
const NEXT = ['Strike mainnet', 'Ethereum wallets', 'More venues behind one API'];

export default function Landing() {
  const { market } = useLive();
  // Show the busiest of the top bid levels so the queue is visible even when the best bid has one order.
  const showcase = market?.book?.bids.slice(0, 5).reduce<BookLevel | undefined>((a, l) => (!a || l.orders.length > a.orders.length ? l : a), undefined);
  const orders = market?.book ? [...market.book.bids, ...market.book.asks].reduce((sum, l) => sum + l.orders.length, 0) : null;

  return (
    <div className="grid gap-24 pb-10">
      <section className="relative grid items-start gap-10 pt-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="hero-grid pointer-events-none absolute -inset-x-10 -top-10 h-[34rem]" aria-hidden />
        <div className="relative grid gap-6 animate-rise">
          <span className="flex w-fit items-center gap-2 rounded-full border border-maker/40 bg-maker/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-maker">
            <span className="h-1.5 w-1.5 rounded-full bg-maker" /> Public beta on Strike testnet
          </span>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Your agent decides.
            <br />
            <span className="text-maker">Argus executes.</span>
          </h1>
          <p className="max-w-[34rem] text-lg leading-8 text-neutral-300">
            The execution layer for AI trading agents. Argus turns every order your agent sends into a maker order on Strike's live order book, and returns a receipt you can verify for every fill.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="#/developers" className="btn-primary">Get API access</a>
            <a href="#/trade" className="btn-ghost">Try it in paper mode</a>
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
          <CodeCard />
          <QueueHero level={showcase} side="buy" />
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
        <div className="grid content-start gap-3">
          <span className="eyebrow">Why an execution layer</span>
          <h2 className="text-3xl font-semibold tracking-tight">Agents are becoming traders. Most trade badly.</h2>
          <p className="max-w-prose leading-7 text-neutral-400">
            An agent that sends market orders pays the taker fee and the spread on every trade, thousands of times. Working a limit order well means watching the queue, moving when outbid and knowing when to give up: exactly the part agents are worst at. Argus does it for them, and proves what it did.
          </p>
        </div>
        <div className="panel p-5">
          <span className="eyebrow">A $10,000 BTC buy · Strike mainnet base tier</span>
          <div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-x-6 gap-y-2 text-sm">
            <span />
            <span className="text-right text-neutral-500">Market order</span>
            <span className="text-right text-neutral-500">Filled as maker</span>
            {[
              ['Exchange fee', '$5.00 paid', '$0.50 rebate'],
              ['Argus fee', '—', '$2.00'],
              ['Net fees', '$5.00', '$1.50'],
            ].map(([label, a, b]) => (
              <div key={label} className="contents">
                <span className="text-neutral-300">{label}</span>
                <span className="text-right font-mono num text-taker">{a}</span>
                <span className="text-right font-mono num text-maker">{b}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-5 text-neutral-500">Before the spread, which a maker order also avoids. Every receipt counts price moves while the order waits, so savings are never overstated.</p>
        </div>
      </section>

      <section className="grid gap-8">
        <div className="grid gap-2">
          <span className="eyebrow">How it works</span>
          <h2 className="text-3xl font-semibold tracking-tight">From one signature to a verified fill.</h2>
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
          <h2 className="text-3xl font-semibold tracking-tight">Built for programs that trade unattended.</h2>
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
          <span className="eyebrow">Roadmap</span>
          <h2 className="text-3xl font-semibold tracking-tight">Live now, shipping next.</h2>
          <p className="max-w-prose leading-7 text-neutral-400">
            Argus runs on Strike Finance today, with Solana and Cardano wallets. Everything below "Next" is in active development.
          </p>
        </div>
        <div className="grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 sm:grid-cols-2">
          <div className="bg-ink-900 p-5">
            <span className="eyebrow text-maker">Live</span>
            <ul className="mt-3 grid gap-2.5 text-sm text-neutral-300">
              {LIVE.map((x) => (
                <li key={x} className="flex gap-2"><span className="text-maker">✓</span>{x}</li>
              ))}
            </ul>
          </div>
          <div className="bg-ink-900 p-5">
            <span className="eyebrow text-queue">Next</span>
            <ul className="mt-3 grid gap-2.5 text-sm text-neutral-300">
              {NEXT.map((x) => (
                <li key={x} className="flex gap-2"><span className="text-queue">→</span>{x}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="panel grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:p-8">
        <div className="grid gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Your keys, your withdrawals.</h2>
          <p className="max-w-prose text-neutral-400">
            Argus can trade for your account but can never withdraw: withdrawals always need your own wallet's signature and go only to the wallet you connected. Stored keys are encrypted with AES-256-GCM, API keys are stored only as hashes, and you can revoke access at any time.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <a href="#/developers" className="btn-primary">Get API access</a>
          <a href="#/docs/security" className="btn-ghost">Security details</a>
        </div>
      </section>
    </div>
  );
}
