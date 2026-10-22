# Argus

**Get paid to trade on Strike.**

On Strike, market orders pay a 0.05% fee and maker orders earn a 0.005% rebate. Argus takes your order and works it as a maker order, using Strike's live queue data to decide where to wait in line and when to move. You pay less, Strike gets more volume and deeper liquidity, and every order runs through Strike's Builder Codes.

Live: `https://<your-app>.onrender.com`
Demo video: `<link>`
Built for the Strike Hackathon, October 2026.

---

## The problem

Most traders hit market orders. On a $10,000 trade that's $5 in fees, plus the spread, every time. Placing a limit order yourself can save that, but you don't know how long the line is, whether you'll ever get filled, or when to move your price.

Strike publishes something most exchanges don't: an **L3 feed** that shows every resting order in true queue order. Argus uses it to make the call for you.

---

## How it works

1. **Connect once.** Sign one message in Phantom (Solana) or a Cardano wallet such as Lace or Eternl. Argus gets a trading-only key through Strike's Builder Connect. It can place and cancel orders, but it **can't withdraw**. Withdrawals always need your own wallet signature and only go to your own wallet.
2. **Say what you want.** For example: buy 0.002 BTC, finish within 5 minutes, never pay more than 0.10% above the current price.
3. **Argus picks a spot.** It reads the order book order by order and either joins the best bid or improves it by one tick to jump the line, based on how long the queue is and how fast orders are filling.
4. **It only ever posts as maker.** Orders are post-only, so they can't accidentally take liquidity.
5. **It watches your place in line.** You see "#3 in line, 0.012 BTC ahead, about 40 seconds." If the price moves away, Argus moves your order, never past your limit.
6. **Deadline safety net.** If time runs out, Argus finishes the rest with a market order, or cancels if you prefer.
7. **You get a report.** Every number, step by step, compared with what a market order would have cost.

---

## The math (example)

A $10,000 BTC buy at Strike's base tier, with Argus's 2 bps fee, if the order fills fully as maker at the price you arrived at:

| Step | Market order | Through Argus |
|---|---|---|
| 1. Strike fee | 10,000 × 0.0005 = **$5.00 paid** | 10,000 × (−0.00005) = **$0.50 rebate** |
| 2. Argus fee | none | 10,000 × 0.0002 = **$2.00** |
| 3. Net fees | **$5.00** | 2.00 − 0.50 = **$1.50** |
| 4. You save | | 5.00 − 1.50 = **$3.50 (3.5 bps)** |

A market order also pays the spread and walks the book, so real savings are usually higher. Price can also move while you wait, which is why every report compares your result with a market order **at the moment you started**, including price change, not just fees.

---

## Paper mode

Try Argus without a wallet or funds. Paper mode runs the same engine against the **live Strike book**. Your pretend order goes to the back of the real queue at your price, and it only counts as filled once real trades have eaten through every order ahead of it. That's only possible because Strike publishes L3 data.

Paper mode only counts fills it can prove from the public feed:

| Event on the L3 feed | Paper order |
|---|---|
| Trade on an order that was ahead of you | Moves you up the line |
| Cancel or size cut on an order ahead of you | Moves you up the line, no fill |
| Trade on an order that joined behind you at your price | Fills you first (the taker had to pass you) |
| Trade at a worse price on your side | Fills you first (the taker swept past your price) |
| An opposite order rests at your price without trading | **Not** a fill. Market makers usually post with post-only, so it would have been rejected rather than matched. Argus moves your paper order instead |
| Book rebuilt after a dropped connection | Orders ahead that vanished are dropped; no fills are invented |

Deadline market orders in paper mode walk the live book at that moment and pay the taker fee.

---

## Fairness checks

For every real fill, Argus checks the order book just before the fill:

| Check | Meaning |
|---|---|
| Best price | Your order was at the best price on its side |
| First in line | Your order was at the front of the queue at that price |
| On the tape | A matching trade appeared on Strike's public trade feed |

Each fill gets a ✓ or ✗ in your report.

---

## What it does for Strike

| | |
|---|---|
| Volume | Every Argus execution is real Strike volume |
| Liquidity | Orders rest on the book as maker, tightening spreads for everyone |
| Fees | Every order carries Argus's builder code, so the integration earns from day one |
| New users | Paper mode lets anyone see how Strike's book behaves before depositing |

---

## How it uses Strike

| Strike feature | How Argus uses it |
|---|---|
| L3 websocket + snapshot | Rebuilds the BTC-USD book order by order to find queue position and fill speed |
| Trade stream | Measures fill rates and checks fills against the public tape |
| Builder Connect | One-signature onboarding with a trade-only API wallet, from Phantom (Solana) or any CIP-30 Cardano wallet |
| Builder Codes (`X-Builder-Fee-Bps`) | Argus's fee on every order |
| Orders API (`post_only`, replace, cancel, market with `slippage`) | Places and manages maker orders |
| User websocket | Real fills, fees, rebates and maker flag for each order |
| Exchange info | Tick size and minimum order size |

---

## Run it yourself

Requires Node.js 20 or newer. Works on Windows, macOS and Linux.

```powershell
git clone https://github.com/<you>/argus
cd argus
npm install
copy .env.example .env
npm run dev
```

Open `http://localhost:5173`. Paper mode works with no extra setup. Live mode needs a builder code and a master key in `.env`.

### Testing live mode for free on testnet

Strike's testnet takes Cardano test ADA. Get some from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet), deposit it on testnet.strikefinance.org from a Cardano wallet on the same testnet, register your builder code there, then set `STRIKE_ENV=testnet` and connect that Cardano wallet in Argus. The testnet book is thin and its minimum order is $100, so orders mostly rest unfilled, but each one still shows your builder code and fee on Strike.

| Script | What it does |
|---|---|
| `npm run dev` | Server and web app with hot reload |
| `npm test` | Unit tests |
| `npm run build` | Builds server and web |
| `npm start` | Runs the production build on one port |

### Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `STRIKE_ENV` | `mainnet` | `mainnet` or `testnet` |
| `SYMBOL` | `BTC-USD` | Market |
| `PORT` | `8080` | Server port |
| `DATA_DIR` | `./data` | Executions, reports, encrypted keys |
| `BUILDER_CODE` | none | Your Strike builder code (live mode) |
| `BUILDER_MAX_FEE_BPS` | `10` | Max fee users approve when connecting |
| `ARGUS_FEE_BPS` | `2` | Fee charged per order |
| `ARGUS_MASTER_KEY` | none | 32-byte hex key that encrypts stored API wallet keys (live mode) |

---

## API

| Endpoint | Does |
|---|---|
| `GET /api/market` | Book with every order in queue order, spread, fill rates |
| `POST /api/connect/start` | Starts Builder Connect, returns the message to sign |
| `POST /api/connect/finish` | Verifies the signature and signs you in |
| `POST /api/connect/logout` | Signs you out |
| `GET /api/me` | Your connected wallet and account |
| `POST /api/executions` | Starts a paper or live execution |
| `GET /api/executions` | Running and recent executions you can see |
| `GET /api/executions/:id` | Live state, queue position, fills |
| `POST /api/executions/:id/cancel` | Stops and cancels |
| `GET /api/reports/:id` | Full report with every step of the math |
| `GET /api/stats` | Totals across all executions |
| `WS /live` | Live market, execution and fill updates |

---

## Security

- Argus's key for your account can trade but can't withdraw.
- Stored keys are encrypted with AES-256-GCM.
- Every order is post-only unless the deadline fallback runs.
- You can stop any execution at any time, and revoke Argus's key in Strike's app.

---

## Limits

- **BTC-USD only for now.** Strike's L3 feed currently covers one market.
- **Maker orders aren't guaranteed to fill.** The deadline fallback handles this.
- **Waiting has a cost.** Price can move while your order rests. Reports show this honestly.
- **Solana and Cardano wallets.** Ethereum wallets work with Builder Connect too and are next.
- L3 order IDs are public IDs. Argus links your order to its L3 entry by side, price, size and time.

---

## What's next

1. Ethereum wallet support.
2. More markets as Strike enables L3 for them.
3. **Maker Vault:** a Strike vault, run by Argus, that keeps maker orders on the book and shares the rebates and spread with depositors.
4. A public API so other bots and apps can route orders through Argus.

---

## Notes on Strike's behavior

Things observed against the live API while building, beyond what the docs say:

- L3 snapshot price strings aren't normalized: the same book can contain `"82630.0"` and `"82621"`. Argus keys every level by `new Decimal(p).toString()`.
- `GET /price/v2/exchangeInfo` lists several symbols (e.g. `XAU-USD`), but L3 covers BTC-USD only.
- BTC-USD rules (Oct 21, 2026): tick `1`, step and min size `0.00001` BTC, minimum order value `$10`, market orders capped at `120` BTC. A $10 order is enough, so no leverage is needed for a demo.
- The L3 feed is busy (roughly 150 updates per second, mostly quotes being placed and pulled), but actual trades are sparse: often under one per minute. Maker orders can take a while to fill, which is why the deadline fallback matters.
- Measured on Oct 21, 2026 (around 04:00–04:25 UTC): 4 trades in one 10-minute window and **0** in another. Ten paper executions over the same period got no maker fills, and eight finished with the deadline market order. When taker flow is this thin, a maker order mostly waits and then pays the taker fee anyway. Reports show this as it is.
- L3 `trade_id` is the same number as the trade stream's `t`, so fills can be matched to the public tape by ID, not just by price and size.
- A `post_only` order that would cross is cancelled rather than filled (Strike docs, Order Types).

### Checking the L3 sync yourself

```powershell
cd server
npx tsx scripts/soak.ts 10
```

Two more scripts exercise paper mode on the live book:

```powershell
npx tsx scripts/paper-live.ts 10        # rests a paper bid and ask, logs queue position and fills
npx tsx scripts/paper-runs.ts           # 10 paper executions with mixed settings, prints each report
```

`soak.ts` keeps the book in sync for 10 minutes. Every minute it rebuilds a second copy from a fresh snapshot plus the recorded updates, and checks both copies match order by order. It also counts how many tape trades match an L3 `trade_id`.

---

## Built with

Node.js, TypeScript, Fastify, React, Vite, Tailwind CSS, decimal.js, @noble/ed25519, Phantom (direct provider API). Data and trading through Strike Finance's API.
