import { useEffect, type ReactNode } from 'react';

interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="overflow-x-auto rounded-lg border border-ink-700">
    <table className="w-full min-w-[30rem] text-sm">
      <thead className="text-left">
        <tr>{head.map((h) => <th key={h} className="eyebrow px-3 py-2 font-normal">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-ink-700 align-top">
            {r.map((c, j) => <td key={j} className={`px-3 py-2 ${j === 0 ? 'text-neutral-100' : 'text-neutral-300'}`}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900 p-4 font-mono text-[13px] leading-6 text-neutral-200">{children}</pre>
);

const SECTIONS: Section[] = [
  {
    id: 'overview',
    title: 'Overview',
    body: (
      <>
        <p>On Strike, a market order pays a 0.050% taker fee and a resting limit order earns a 0.005% maker rebate. Argus takes your order and works it as a maker order, so you earn the rebate instead of paying the fee.</p>
        <p>What makes this possible is Strike's <b>L3 feed</b>: every resting order on the BTC-USD book, in true queue order. Argus reads it to see exactly how much is ahead of you, how fast that line is moving, and when to move your price.</p>
        <p>Every order goes through Strike Builder Codes with the <code>argus</code> code, so Argus's fee is visible on each order in Strike's own records.</p>
      </>
    ),
  },
  {
    id: 'quickstart',
    title: 'Quick start',
    body: (
      <>
        <p><b>Paper mode, no wallet:</b> open Trade, keep Paper selected, choose a side and size of at least $10 (testnet: $100), pick how long to wait, and start. You watch a pretend order queue on the real book.</p>
        <p><b>Live mode:</b> click Connect wallet, sign one message, deposit funds, switch the form to Live, and start. When the run ends, open the report.</p>
        <Table
          head={['Setting', 'What it does']}
          rows={[
            ['Size', 'BTC amount. Strike requires steps of 0.00001 BTC and an order value of at least $10 on mainnet, $100 on testnet.'],
            ['Finish within', 'Deadline: 1, 5 or 15 minutes. At the deadline the fallback runs.'],
            ['Max price move', 'Your limit in basis points from the mid price when you start. A buy never rests above it, a sell never below it.'],
            ['Style', 'Patient, Balanced or Fast: how long Argus waits in line before jumping it by one tick.'],
            ['If time runs out', 'Finish the rest with a market order, or cancel it.'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'engine',
    title: 'The maker engine',
    body: (
      <>
        <p>Several times a second, Argus decides one of five things: place, move, hold, finish with a market order, or cancel. The rules are simple and every decision is written to the log you see on screen.</p>
        <Table
          head={['Rule', 'Detail']}
          rows={[
            ['Price guard', 'A buy never rests above arrival mid × (1 + max move); a sell never below the mirror.'],
            ['Join or improve', 'Join the best bid, or improve it by one tick when the spread is at least two ticks, so it cannot cross.'],
            ['Pick', 'If the expected fill time at the best bid fits in time left × patience (0.9, 0.6 or 0.3), join. Otherwise improve if it stays inside your limit.'],
            ['Reprice', 'Move when someone posts a better price, or when the queue is more than twice too slow and improving is possible. At most once every 2 seconds.'],
            ['Deadline', 'Market order with your max move as slippage, or cancel. If the order book is offline at the deadline, cancel instead of trading on stale prices.'],
            ['Post-only', 'Every limit order is post-only. If Strike rejects it because it would cross, the next decision uses fresh book data.'],
          ]}
        />
        <p>Expected fill time is the size ahead of you plus your size, divided by the recent fill rate on your side of the book (an exponentially weighted average over about 3 minutes).</p>
      </>
    ),
  },
  {
    id: 'queue',
    title: 'Queue position',
    body: (
      <>
        <p>Live orders are matched to their public L3 entry by side, price, size and timing within a few seconds of Strike confirming them. From then on, the screen shows your exact place in line and the BTC ahead of you, including better prices on your side.</p>
        <p>If no match is found, the position is marked as estimating and assumes you are at the back of your price level.</p>
      </>
    ),
  },
  {
    id: 'paper',
    title: 'Paper mode',
    body: (
      <>
        <p>Paper mode runs the same engine on the live mainnet book. Your pretend order joins the back of the real queue at your price and only counts as filled when the public feed proves a real trade would have reached it.</p>
        <Table
          head={['Event on the L3 feed', 'Effect on the paper order']}
          rows={[
            ['Trade on an order that was ahead of you', 'Moves you up the line'],
            ['Cancel or size cut on an order ahead of you', 'Moves you up the line, no fill'],
            ['Trade on an order that joined behind you at your price', 'Fills you first; the taker had to pass you'],
            ['Trade at a worse price on your side', 'Fills you first; the taker swept past your price'],
            ['Opposite order rests at your price without trading', 'Not a fill. It may have been post-only, so Argus moves your order instead'],
            ['Book rebuilt after a dropped connection', 'Vanished orders ahead are dropped; no fills are invented'],
          ]}
        />
        <p>Deadline market orders in paper mode walk the live book and pay the taker fee.</p>
      </>
    ),
  },
  {
    id: 'report',
    title: 'Execution report',
    body: (
      <>
        <p>Every run ends with a report that shows each step of the math with your real numbers. For a buy (sells mirror the signs):</p>
        <Table
          head={['Step', 'Formula']}
          rows={[
            ['1. Average price', 'Σ(price × size) / Q'],
            ['2. Price cost', '(average − arrival mid) × Q, negative is good'],
            ['3. Strike fees', 'Sum of fees on each fill; a rebate is negative'],
            ['4. Argus fee', 'Notional × 2 bps'],
            ['5. Total cost', 'Price cost + Strike fees + Argus fee'],
            ['6. Market order at arrival', 'Walk the stored book at arrival for Q, plus the taker fee'],
            ['7. You saved', 'Market cost − total cost, also in bps of notional'],
            ['8. Filled as maker', 'Maker-filled size / Q'],
          ]}
        />
        <p>The baseline is a market order at the moment you started. A maker order can wait while price moves away, and the report counts that honestly.</p>
      </>
    ),
  },
  {
    id: 'fairness',
    title: 'Fairness checks',
    body: (
      <>
        <p>For every live maker fill, Argus looks at the L3 book just before the trade touched your order:</p>
        <Table
          head={['Check', 'Meaning']}
          rows={[
            ['Best price', 'Your order was at the best price on its side'],
            ['First in line', 'Your order was at the front of its price level'],
            ['On the tape', 'The trade appears on Strike\'s public trade feed. L3 trade_id and the tape\'s trade id are the same number, so the match is exact.'],
          ]}
        />
        <p>A ✗ means a check did not pass. See the data. It does not by itself mean anything went wrong.</p>
      </>
    ),
  },
  {
    id: 'wallets',
    title: 'Wallets and funds',
    body: (
      <>
        <p>Argus connects through Strike Builder Connect. You sign one message; Strike creates a trade-only API wallet linked to the <code>argus</code> builder code and a maximum fee you approve (10 bps).</p>
        <Table
          head={['Wallet', 'Connect', 'Deposit', 'Withdraw']}
          rows={[
            ['Phantom (Solana)', 'Yes', "Through Strike's app", 'Yes, signed in Phantom'],
            ['Lace, Eternl, Nami (Cardano)', 'Yes', 'Yes, ADA, inside Argus', 'Yes, signed in your wallet'],
          ]}
        />
        <p>Deposits use Strike's quote and Strike builds the transaction, so the destination is fixed by Strike and your wallet shows the exact amount before you approve. Strike's minimum deposit is $5.</p>
        <p>Mainnet and testnet are separate accounts with separate sign-ins. On testnet, get Preprod test ADA from the Cardano faucet and deposit it.</p>
      </>
    ),
  },
  {
    id: 'security',
    title: 'Security',
    body: (
      <>
        <Table
          head={['Concern', 'How Argus handles it']}
          rows={[
            ['Withdrawals', "Argus's key cannot withdraw. Every withdrawal needs your wallet's signature, and Strike sends funds only to the wallet you connected."],
            ['Stored keys', 'Encrypted at rest with AES-256-GCM. The wallet address is bound into each record, so a record cannot be moved to another user.'],
            ['Sessions', 'Random httpOnly, SameSite=Lax cookies. Only a hash of each token is stored.'],
            ['Orders', 'Post-only unless the deadline fallback runs. At most 2 order actions per second per user.'],
            ['Your control', "Stop any run at any time. Revoke Argus's key in Strike's app whenever you like."],
            ['Privacy', 'Live runs are visible only to their owner. Paper runs are public demos.'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'limits',
    title: 'Limits',
    body: (
      <>
        <p><b>BTC-USD only.</b> Strike's L3 feed currently covers one market.</p>
        <p><b>Maker orders are not guaranteed to fill.</b> When few takers trade, an order can wait the whole time and finish with the deadline fallback. Reports show it.</p>
        <p><b>Waiting has a cost.</b> Price can move while your order rests.</p>
        <p><b>Testnet is thin.</b> Its book has few orders and a $100 minimum, so orders mostly rest unfilled. They still show the builder code and fee on Strike.</p>
      </>
    ),
  },
  {
    id: 'selfhost',
    title: 'Run it yourself',
    body: (
      <>
        <p>Node.js 20 or newer. Paper mode works with no configuration.</p>
        <Code>{`git clone https://github.com/softalpha0/Argus
cd Argus
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev               # http://localhost:5173`}</Code>
        <Table
          head={['Variable', 'Default', 'Meaning']}
          rows={[
            [<code key="a">STRIKE_ENV</code>, 'mainnet', 'mainnet or testnet'],
            [<code key="b">BUILDER_CODE</code>, '—', 'Your builder code, exactly as Strike stores it'],
            [<code key="c">ARGUS_MASTER_KEY</code>, '—', '64 hex characters; encrypts stored API wallet keys'],
            [<code key="d">ARGUS_FEE_BPS</code>, '2', 'Fee per order'],
            [<code key="e">BUILDER_MAX_FEE_BPS</code>, '10', 'Maximum fee users approve at connect'],
            [<code key="f">DATA_DIR</code>, './data', 'Executions, reports, encrypted keys'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'api',
    title: 'API',
    body: (
      <Table
        head={['Endpoint', 'Does']}
        rows={[
          ['GET /api/market', 'Book with every order in queue order, spread, fill rates'],
          ['POST /api/executions', 'Start a paper or live run'],
          ['GET /api/executions/:id', 'Live state, queue position, fills'],
          ['POST /api/executions/:id/cancel', 'Stop and cancel'],
          ['GET /api/reports/:id', 'Report with every step of the math'],
          ['GET /api/stats', 'Totals across runs'],
          ['POST /api/connect/start, /finish', 'Builder Connect'],
          ['POST /api/funds/deposit/*, /withdraw/*', 'Deposits and withdrawals'],
          ['WS /live', 'Market, execution, fill and report updates'],
        ]}
      />
    ),
  },
];

export default function Docs({ section }: { section?: string }) {
  useEffect(() => {
    if (!section) return;
    document.getElementById(`doc-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [section]);

  return (
    <div className="grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav className="lg:sticky lg:top-6 lg:self-start" aria-label="Documentation">
        <span className="eyebrow">Documentation</span>
        <ul className="mt-3 flex flex-wrap gap-1 lg:grid lg:gap-0.5">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#/docs/${s.id}`} className={`block rounded-md px-2.5 py-1.5 text-sm ${section === s.id ? 'bg-ink-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100'}`}>
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <article className="prose-doc grid min-w-0 max-w-3xl gap-14">
        <header className="grid gap-3">
          <h1 className="text-4xl font-semibold tracking-tight">How Argus works</h1>
          <p className="text-lg">Everything Argus does with your order, and why. Every number on screen can be traced back to a rule on this page.</p>
        </header>
        {SECTIONS.map((s) => (
          <section key={s.id} id={`doc-${s.id}`} className="grid scroll-mt-6 gap-4">
            <h2 className="text-2xl font-semibold tracking-tight">{s.title}</h2>
            {s.body}
          </section>
        ))}
      </article>
    </div>
  );
}
