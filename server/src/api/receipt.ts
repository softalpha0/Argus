import type { ExecutionReport } from '../report/Report.js';
import type { RecordedFill } from '../engine/Execution.js';

export const RECEIPT_SCHEMA = 'argus.receipt.v1';

/** What the v1 views read from a running execution's toJSON() or a stored record (same fields). */
export interface ExecutionSnapshot {
  id: string;
  mode: 'paper' | 'live';
  side: 'buy' | 'sell';
  size: string;
  deadlineSec?: number;
  maxSlippageBps?: number;
  preset?: string;
  fallback?: string;
  state: string;
  createdAt: number;
  endedAt: number | null;
  deadline?: number;
  timeLeftSec?: number;
  arrivalMid?: string | null;
  limitPrice?: string | null;
  filled?: string;
  working?: { id: string; price: string; size: string; filled: string; queue: { place: number | null; sizeAhead: string; estimating: boolean; etaSec: number | null } | null } | null;
  status?: string | null;
  fills?: RecordedFill[];
  error?: string | null;
  report?: ExecutionReport | null;
  audit?: unknown;
}

export interface VenueInfo {
  exchange: string;
  network: 'mainnet' | 'testnet';
  symbol: string;
}

export interface ExecutionMeta {
  apiKeyId?: string;
  clientRef?: string;
}

const FINISHED = new Set(['done', 'canceled', 'failed']);
export const isFinished = (j: { state: string }) => FINISHED.has(j.state);

/** How much of the order filled, once it has finished. */
function outcome(j: ExecutionSnapshot): 'filled' | 'partially_filled' | 'not_filled' | null {
  if (!isFinished(j)) return null;
  const filled = Number(j.report?.filledSize ?? j.filled ?? 0);
  const size = Number(j.size);
  if (filled <= 0) return 'not_filled';
  return filled >= size - 1e-12 ? 'filled' : 'partially_filled';
}

/** The v1 view of an execution: stable field names for programs, no UI-only detail. */
export function executionView(j: ExecutionSnapshot, venue: VenueInfo, meta: ExecutionMeta = {}) {
  const w = j.working;
  return {
    object: 'execution' as const,
    id: j.id,
    clientRef: meta.clientRef ?? null,
    venue,
    mode: j.mode,
    side: j.side,
    size: j.size,
    params: { deadlineSec: j.deadlineSec ?? null, maxSlippageBps: j.maxSlippageBps ?? null, preset: j.preset ?? null, fallback: j.fallback ?? null },
    state: j.state,
    outcome: outcome(j),
    createdAt: j.createdAt,
    endedAt: j.endedAt,
    deadline: j.deadline ?? null,
    timeLeftSec: isFinished(j) ? 0 : (j.timeLeftSec ?? null),
    arrivalMid: j.arrivalMid ?? null,
    limitPrice: j.limitPrice ?? null,
    filled: j.report?.filledSize ?? j.filled ?? '0',
    workingOrder: w
      ? {
          price: w.price,
          size: w.size,
          filled: w.filled,
          queue: w.queue ? { place: w.queue.place, sizeAhead: w.queue.sizeAhead, estimating: w.queue.estimating, etaSec: w.queue.etaSec } : null,
        }
      : null,
    message: j.status ?? null,
    error: j.error ?? null,
    fillCount: j.fills?.length ?? 0,
    receipt: isFinished(j) ? `/v1/executions/${j.id}/receipt` : null,
  };
}

type Check = 'pass' | 'fail' | 'unknown';

/** Fairness checks per fill (live only): each is "pass", "fail" or "unknown". */
function checks(c: Record<string, unknown> | undefined) {
  if (!c) return null;
  const pick = (k: string): Check | null => (c[k] === 'pass' || c[k] === 'fail' || c[k] === 'unknown' ? c[k] : null);
  return {
    pending: c.pending === true,
    bestPrice: pick('bestPrice'),
    firstInLine: pick('firstInLine'),
    onTape: pick('onTape'),
    linked: typeof c.linked === 'boolean' ? c.linked : null,
    note: typeof c.note === 'string' ? c.note : null,
  };
}

/** One fill as v1 reports it, on the event stream and in receipts. */
export function fillView(f: RecordedFill) {
  return {
    time: f.ts,
    size: f.size,
    price: f.price,
    liquidity: f.isMaker ? ('maker' as const) : ('taker' as const),
    venueFee: f.fee,
    builderFee: f.builderFee ?? null,
    tradeId: f.tradeId ?? null,
    checks: checks(f.checks),
  };
}

/**
 * Receipt v1: one self-contained record of what happened and what it cost, against
 * a market order placed at the moment the execution started. Amounts are decimal
 * strings in USD; sizes in the base asset.
 */
export function buildReceipt(j: ExecutionSnapshot, venue: VenueInfo, meta: ExecutionMeta = {}) {
  const r = j.report ?? null;
  const fills = (j.fills ?? []).map(fillView);
  const orders = (j.audit as { orders?: unknown[] } | null | undefined)?.orders ?? null;
  return {
    schema: RECEIPT_SCHEMA,
    executionId: j.id,
    clientRef: meta.clientRef ?? null,
    apiKeyId: meta.apiKeyId ?? null,
    venue,
    mode: j.mode,
    side: j.side,
    requested: {
      size: j.size,
      deadlineSec: j.deadlineSec ?? null,
      maxSlippageBps: j.maxSlippageBps ?? null,
      preset: j.preset ?? null,
      fallback: j.fallback ?? null,
    },
    state: j.state,
    outcome: outcome(j),
    error: j.error ?? null,
    timing: { createdAt: j.createdAt, endedAt: j.endedAt, durationMs: j.endedAt ? j.endedAt - j.createdAt : null },
    arrival: { mid: r?.arrivalMid ?? j.arrivalMid ?? null, limitPrice: j.limitPrice ?? null },
    result: r
      ? { filledSize: r.filledSize, avgPrice: r.avgPrice, notional: r.notional, makerShare: r.makerShare, makerSize: r.makerSize }
      : null,
    costs: r ? { priceVsArrival: r.priceCost, venueFees: r.strikeFees, builderFee: r.argusFee, total: r.totalCost } : null,
    benchmark: r
      ? {
          description: 'Market order for the filled size, walked through the order book at arrival, plus the taker fee',
          avgPrice: r.baselineAvg,
          cost: r.baselineCost,
          saved: r.savings,
          savedBps: r.savingsBps,
        }
      : null,
    fills,
    venueOrders: orders,
    notes: r?.notes ?? [],
  };
}

export type Receipt = ReturnType<typeof buildReceipt>;
export type ExecutionView = ReturnType<typeof executionView>;
