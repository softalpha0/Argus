import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ArgusApiError, type ArgusClient, type MarketLevel } from './client.js';

const VERSION = '0.1.0';
const FINISHED = new Set(['done', 'canceled', 'failed']);

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (summary: string, data: unknown): Content => ({
  content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});

/** Errors come back as tool results the model can read and act on, not protocol failures. */
async function run(fn: () => Promise<Content>): Promise<Content> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof ArgusApiError ? `Argus error (${err.type}): ${err.message}` : `Could not reach Argus: ${(err as Error).message}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

/** Average price of taking `size` from the book, best level first. */
export function walk(levels: MarketLevel[], size: number): { avg: number; worst: number; filled: number } | null {
  let left = size;
  let cost = 0;
  let worst = 0;
  for (const l of levels) {
    if (left <= 0) break;
    const take = Math.min(left, Number(l.total));
    cost += take * Number(l.price);
    worst = Number(l.price);
    left -= take;
  }
  const filled = size - left;
  return filled > 0 ? { avg: cost / filled, worst, filled } : null;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** One-line description of an execution for the model to relay. */
function describe(e: Record<string, unknown>): string {
  const wo = e.workingOrder as { price: string; queue?: { place: number | null } | null } | null;
  const parts = [`${e.mode} ${e.side} ${e.size} — state ${e.state}`, `filled ${e.filled}`];
  if (wo) parts.push(`resting at ${wo.price}${wo.queue?.place ? `, #${wo.queue.place} in line` : ''}`);
  if (e.outcome) parts.push(`outcome ${e.outcome}`);
  if (e.error) parts.push(`error: ${e.error}`);
  return parts.join(' · ');
}

function receiptSummary(r: Record<string, unknown>): string {
  const res = r.result as { filledSize: string; avgPrice: string | null; makerShare: string } | null;
  const b = r.benchmark as { saved: string | null; savedBps: string | null } | null;
  if (!res) return `Receipt: ${r.outcome ?? r.state}.`;
  const maker = Math.round(Number(res.makerShare) * 100);
  const saved = b?.saved != null ? ` Saved ${round(Number(b.saved), 4)} USD (${round(Number(b.savedBps), 2)} bps) versus a market order at arrival.` : '';
  return `Receipt: ${r.outcome}. Filled ${res.filledSize} at an average of ${res.avgPrice ?? '-'}, ${maker}% as maker.${saved}`;
}

/**
 * The Argus tools for AI agents: read the market, price a market order, and run
 * maker-first executions with receipts. Every call goes through the v1 API with the
 * agent's API key, so its limits and privacy apply.
 */
export function createArgusMcpServer(client: ArgusClient, opts: { pollMs?: number } = {}): McpServer {
  const pollMs = opts.pollMs ?? 2000;
  const server = new McpServer(
    { name: 'argus', version: VERSION },
    {
      instructions:
        'Argus executes crypto orders for you as maker orders on Strike Finance (BTC-USD perpetuals) and returns a receipt for each run. ' +
        'Use paper mode unless the user explicitly asks to trade live with real funds. Check argus_quote before large orders. ' +
        'Sizes are in BTC as decimal strings. After starting an execution, follow it with argus_status or wait for it with waitSeconds, then report the receipt.',
    },
  );

  server.registerTool(
    'argus_market',
    {
      title: 'Market snapshot',
      description: 'Current BTC-USD mid price, spread, trading rules (tick size, minimum size and order value) and the top of the order book on Strike.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const m = await client.market();
        const top = (side: MarketLevel[] | undefined) => (side ?? []).slice(0, 5).map((l) => ({ price: l.price, size: l.total }));
        return ok(`${m.symbol}: mid ${m.mid ?? 'unknown'}, spread ${m.spread ?? 'unknown'}${m.live ? '' : ' (order book resyncing)'}.`, {
          symbol: m.symbol,
          live: m.live,
          mid: m.mid,
          spread: m.spread,
          rules: m.rules,
          bids: top(m.book?.bids),
          asks: top(m.book?.asks),
        });
      }),
  );

  server.registerTool(
    'argus_quote',
    {
      title: 'Price a market order',
      description:
        'Estimates what a market order would cost right now by walking the live order book, and what working it as a maker order through Argus would cost instead. Use before deciding on size or urgency.',
      inputSchema: {
        side: z.enum(['buy', 'sell']).describe('buy or sell'),
        size: z.string().regex(/^\d+(\.\d+)?$/).describe('Size in BTC, e.g. "0.002"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ side, size }) =>
      run(async () => {
        const [m, cfg] = await Promise.all([client.market(), client.config()]);
        const qty = Number(size);
        const mid = Number(m.mid);
        if (!m.book || !m.mid) throw new ArgusApiError(503, 'unavailable', 'The order book is not available right now');
        const w = walk(side === 'buy' ? m.book.asks : m.book.bids, qty);
        if (!w) throw new ArgusApiError(503, 'unavailable', 'No liquidity on that side of the book');
        const slip = ((w.avg - mid) / mid) * 10_000 * (side === 'buy' ? 1 : -1);
        const takerBps = Number(cfg.takerFee) * 10_000;
        const makerBps = Number(cfg.makerFee) * 10_000;
        const best = Number((side === 'buy' ? m.book.bids : m.book.asks)[0]?.price ?? mid);
        const makerPriceBps = ((best - mid) / mid) * 10_000 * (side === 'buy' ? 1 : -1);
        const notional = qty * mid;
        const data = {
          side,
          size,
          mid: m.mid,
          notionalUsd: round(notional),
          marketOrder: {
            avgPrice: round(w.avg, 2),
            worstPrice: w.worst,
            fullyFillable: w.filled >= qty - 1e-12,
            priceImpactBps: round(slip, 2),
            takerFeeBps: round(takerBps, 2),
            totalCostBps: round(slip + takerBps, 2),
            totalCostUsd: round((notional * (slip + takerBps)) / 10_000, 4),
          },
          makerThroughArgus: {
            restingPrice: best,
            priceVsMidBps: round(makerPriceBps, 2),
            exchangeFeeBps: round(makerBps, 2),
            argusFeeBps: cfg.argusFeeBps,
            totalCostBps: round(makerPriceBps + makerBps + cfg.argusFeeBps, 2),
            note: 'Applies if it fills as maker; fills are not guaranteed, and the price can move while the order waits.',
          },
          minimumOrderUsd: m.rules ? Number(m.rules.minNotional) : null,
        };
        return ok(
          `A market ${side} of ${size} BTC would cost about ${data.marketOrder.totalCostBps} bps ($${data.marketOrder.totalCostUsd}); filled as maker through Argus about ${data.makerThroughArgus.totalCostBps} bps.`,
          data,
        );
      }),
  );

  server.registerTool(
    'argus_execute',
    {
      title: 'Start an execution',
      description:
        'Works a BTC-USD order as a post-only maker order on Strike, moving when outbid but never past maxSlippageBps from the price at the start, and finishing at the deadline with the chosen fallback. ' +
        'mode "paper" trades against the real order book without placing orders and is the default; use "live" only when the user explicitly asks to trade real funds. ' +
        'Set waitSeconds (up to 120) to wait for it to finish and get the receipt in the same call.',
      inputSchema: {
        side: z.enum(['buy', 'sell']),
        size: z.string().regex(/^\d+(\.\d+)?$/).describe('Size in BTC, e.g. "0.002"'),
        mode: z.enum(['paper', 'live']).default('paper'),
        deadlineSec: z.number().int().min(10).max(3600).default(300).describe('Seconds to work the order before the fallback'),
        maxSlippageBps: z.number().min(1).max(500).default(10).describe('Never pay more (or sell for less) than this many bps from the price at the start'),
        preset: z.enum(['patient', 'balanced', 'fast']).default('balanced'),
        fallback: z.enum(['market', 'cancel']).default('market').describe('At the deadline: finish the rest with a market order, or cancel it'),
        clientRef: z.string().max(100).optional().describe('Your own reference, returned on the receipt'),
        idempotencyKey: z.string().max(200).optional().describe('Reuse the same key when retrying, so the order is not placed twice'),
        waitSeconds: z.number().int().min(0).max(120).default(0),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) =>
      run(async () => {
        const { idempotencyKey, waitSeconds, ...body } = a;
        let e = await client.execute(body, idempotencyKey);
        const id = String(e.id);
        const until = Date.now() + waitSeconds * 1000;
        while (waitSeconds > 0 && !FINISHED.has(String(e.state)) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, until - Date.now()))));
          e = await client.get(id);
        }
        if (FINISHED.has(String(e.state))) {
          const r = await client.receipt(id);
          return ok(`Execution ${id} finished. ${receiptSummary(r)}`, { execution: e, receipt: r });
        }
        return ok(`Started execution ${id}: ${describe(e)}. Check it with argus_status, or get the receipt with argus_receipt once it finishes.`, e);
      }),
  );

  server.registerTool(
    'argus_status',
    {
      title: 'Execution status',
      description: 'State of one execution: filled size, working order and its place in line, time left.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      run(async () => {
        const e = await client.get(id);
        return ok(describe(e), e);
      }),
  );

  server.registerTool(
    'argus_receipt',
    {
      title: 'Execution receipt',
      description: 'The receipt of a finished execution: fills, fees, the builder fee, and the saving against a market order at arrival. If it is still running, returns its status instead.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      run(async () => {
        try {
          const r = await client.receipt(id);
          return ok(receiptSummary(r), r);
        } catch (err) {
          if (err instanceof ArgusApiError && err.type === 'not_ready') {
            const e = await client.get(id);
            return ok(`Still running: ${describe(e)}. Try again when it finishes.`, e);
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    'argus_cancel',
    {
      title: 'Cancel an execution',
      description: 'Stops a running execution and cancels its working order. Safe to repeat.',
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ id }) =>
      run(async () => {
        const e = await client.cancel(id);
        return ok(`Execution ${id}: ${describe(e)}`, e);
      }),
  );

  server.registerTool(
    'argus_list',
    {
      title: 'Recent executions',
      description: 'Your most recent executions, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) =>
      run(async () => {
        const { data } = await client.list(limit);
        return ok(data.length ? data.map((e) => `${e.id}: ${describe(e)}`).join('\n') : 'No executions yet.', data);
      }),
  );

  return server;
}
