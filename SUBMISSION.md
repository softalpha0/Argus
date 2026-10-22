# Argus: submission kit

Everything needed for the Strike Hackathon form. Fill the three blanks marked **TODO** before submitting.

## Links

| | |
|---|---|
| Repo | https://github.com/softalpha0/Argus |
| Live app | **TODO** Render URL |
| Demo video | **TODO** link (under 3 minutes) |

## One line

Argus works your Strike orders as maker orders using live L3 queue data, so you earn the maker rebate instead of paying the taker fee, and every order runs through Strike Builder Codes.

## Short description (≈100 words)

On Strike, market orders pay 0.05% and maker orders earn a 0.005% rebate, yet most traders pay. Argus takes your order and works it as a post-only maker order. It rebuilds Strike's L3 book order by order to see exactly how much is ahead of you and how fast the line moves, then joins the best bid, jumps it by a tick, or reprices, never past your limit. A deadline fallback finishes the rest. Every run ends with a step-by-step report against a market order at arrival, plus fairness checks per fill. Paper mode runs the same engine on the real queue with no wallet.

## How it uses Strike

- **L3 websocket and snapshot:** full order-by-order book with strict sequence checks; queue position and fill rate. A 10-minute mainnet soak applied 114,483 updates with 0 gaps and matched 9 of 9 fresh snapshots order by order.
- **Builder Connect:** one signature from Phantom or a Cardano wallet creates a trade-only API wallet.
- **Builder Codes:** `X-Builder-Fee-Bps: 2` on every order; reports list each order as Strike reports it, with its Builder code and fee.
- **Orders API and user websocket:** post-only orders, atomic replace, cancel, market fallback; real fills, fees, rebates and the maker flag.
- **Trade stream:** fairness checks; L3 `trade_id` equals the tape's trade ID.
- **Builder deposit and withdraw:** fund and withdraw from inside the app; Strike fixes the destination and recipient.

## What it does for Strike

More volume, resting liquidity that tightens spreads, builder fees on every order, and a no-wallet paper mode that shows new users how Strike's book behaves.

## Proof it works

Live results on Strike testnet, Oct 22, 2026, through builder code `Argus` with a Cardano (Lace) wallet:

| Run | Size | Filled as maker | Saved vs a market order at arrival |
|---|---|---|---|
| 1 | 0.0013 BTC | 100% | $0.1913 |
| 2 | 0.0015 BTC | 100% | $0.2123 |
| **Total** | **0.00277 BTC · $225.61** | **100%** | **$0.4036 (17.89 bps), after $0.0451 of Argus fees** |

Strike reported a $0 maker commission on testnet, so the saving here comes from resting inside the spread rather than the rebate; on mainnet the 0.005% rebate adds to it.

Strike's own builder dashboard (testnet.strikefinance.org/builder-codes), Oct 22, 2026: builder code **Argus · Active · 10 bps max · Total Volume $228.30 · Earned Rewards $0.04**. That matches Argus's orders exactly: order 243142756 (0.0013 BTC maker fill, $106.12) plus a 0.0015 BTC deadline market order ($122.18), each paying the 2 bps builder fee rounded down to the cent ($0.02 + $0.02).

After the fix, run `eda21c0e` (0.002 BTC) shows the builder fee as Strike charged it on the fill: **$0.03** in `ORDER_TRADE_UPDATE.builder_fee` (2 bps of $163.00, rounded down to the cent). Strike's order records for that run show the reprices as cancel-then-place (orders 243143393 and 243143398 cancelled, market order 243143403 filled), so every order carried the fee.

One early run filled on an order that had been repriced with `POST /v2/order/replace`. Strike's builder reference notes that endpoint ignores the builder-fee header, and that fill did not count toward the code. Argus now reprices by cancel then place, so every order carries the fee.

Order records from Strike:

| Network | Order ID | Builder | Status |
|---|---|---|---|
| Testnet | 243142756 | Argus · 2 bps (in the builder dashboard's volume) | filled as maker |
| Testnet | 243143403 | builder_fee $0.03 on the fill, from Strike | filled (deadline market order) |
| Mainnet | **TODO** (optional, needs about $5) | argus · 2 bps | |

Screenshots: `docs/screenshots/` (landing, trade, execution, report, stats, docs).

## Demo video script (under 3 minutes)

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Landing page, fee card | On Strike, takers pay 0.05% and makers get paid 0.005%. Most people pay. |
| 0:20–0:35 | Landing queue card, then Docs → Paper mode | Strike publishes every order in queue order. Argus reads it to decide where to wait. |
| 0:35–0:55 | Connect wallet → Lace, sign | One signature. Argus can trade but can never withdraw. |
| 0:55–1:40 | Trade → Live buy → execution view | Argus picks a spot, shows "#1 in line", moves when outbid, and only ever posts as maker. |
| 1:40–2:10 | Report: summary, 8 steps, orders table | Every number, step by step, against a market order at the start. Here is the order on Strike with the Argus builder code. |
| 2:10–2:30 | Paper mode run and Stats | Anyone can try it with no wallet, on the real queue. |
| 2:30–2:50 | Deposit and withdraw window | Fund and withdraw without leaving Argus, back to your own wallet only. |
| 2:50–3:00 | Landing | More maker volume and builder fees for Strike. Next: a Maker Vault and every L3 market. |

## Post on X

> Built Argus for the @strikeperps hackathon: it works your Strike orders as maker orders using the L3 order book, so you earn the rebate instead of paying the taker fee. Live queue position, a deadline safety net, and a report that shows every number. Paper mode needs no wallet. **TODO** link

## Checklist

- [ ] Repo pushed and public
- [ ] Render deployed; `/healthz` returns ok; landing loads on a phone
- [ ] One live order on testnet (or mainnet) with the builder code shown in the report
- [ ] Demo video recorded and linked
- [ ] Links filled in above and in README
- [ ] Form submitted
- [ ] Post on X tagging @strikeperps
