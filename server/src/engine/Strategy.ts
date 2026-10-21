import { Decimal } from 'decimal.js';
import type { Side } from '../book/OrderBook.js';

export type Preset = 'patient' | 'balanced' | 'fast';
export type Fallback = 'market' | 'cancel';

export const PATIENCE: Record<Preset, number> = { patient: 0.9, balanced: 0.6, fast: 0.3 };
export const REPRICE_COOLDOWN_MS = 2000;

export interface StrategyParams {
  side: Side;
  maxSlippageBps: number;
  preset: Preset;
  fallback: Fallback;
}

export interface StrategyInput {
  params: StrategyParams;
  arrivalMid: Decimal;
  tickSize: Decimal;
  bestBid?: Decimal;
  bestAsk?: Decimal;
  /** Size still to execute. */
  remaining: Decimal;
  timeLeftSec: number;
  now: number;
  lastRepriceAt: number | null;
  /** `crossed`: the opposite side now rests at or through our price (paper only; live can't be crossed). */
  working: { price: Decimal; crossed?: boolean } | null;
  /** Seconds to fill `remaining` at `price`; `asWorking` uses the working order's real queue. */
  estimate(price: Decimal, asWorking: boolean): number;
}

export type Decision =
  | { type: 'place'; price: Decimal; reason: string }
  | { type: 'replace'; price: Decimal; reason: string }
  | { type: 'hold'; reason: string }
  | { type: 'cross'; size: Decimal; reason: string }
  | { type: 'cancel'; reason: string };

/** Worst price the user accepts: buy never above, sell never below. Rounded inside the limit. */
export function priceGuard(side: Side, arrivalMid: Decimal, maxSlippageBps: number, tick: Decimal): Decimal {
  const f = new Decimal(maxSlippageBps).div(10_000);
  if (side === 'buy') return arrivalMid.mul(new Decimal(1).plus(f)).div(tick).floor().mul(tick);
  return arrivalMid.mul(new Decimal(1).minus(f)).div(tick).ceil().mul(tick);
}

const within = (side: Side, price: Decimal, guard: Decimal) => (side === 'buy' ? price.lte(guard) : price.gte(guard));
/** True if a is a more aggressive price than b for this side. */
const better = (side: Side, a: Decimal, b: Decimal) => (side === 'buy' ? a.gt(b) : a.lt(b));

interface Candidates {
  join?: Decimal;
  improve?: Decimal;
}

function candidates(inp: StrategyInput): Candidates {
  const { side } = inp.params;
  const tick = inp.tickSize;
  const own = side === 'buy' ? inp.bestBid : inp.bestAsk;
  const opp = side === 'buy' ? inp.bestAsk : inp.bestBid;
  const step = side === 'buy' ? tick : tick.neg();
  if (!own) {
    // Empty side: sit one tick inside the opposite best, which can't cross.
    return opp ? { join: opp.minus(step) } : {};
  }
  const out: Candidates = { join: own };
  // Improving needs a spread of at least 2 ticks so the new price can't cross.
  if (opp && opp.minus(own).abs().gte(tick.mul(2))) out.improve = own.plus(step);
  return out;
}

/** Choose between join and improve for a fresh order. */
function pick(inp: StrategyInput, guard: Decimal): { price: Decimal; reason: string } | null {
  const { side, preset } = inp.params;
  const c = candidates(inp);
  if (!c.join) return null;
  const sideWord = side === 'buy' ? 'bid' : 'ask';
  if (!within(side, c.join, guard)) {
    return { price: guard, reason: `best ${sideWord} is past your limit, waiting at your limit ${guard}` };
  }
  const budget = inp.timeLeftSec * PATIENCE[preset];
  const joinEta = inp.estimate(c.join, false);
  if (joinEta <= budget) return { price: c.join, reason: `joined best ${sideWord} (expected ${fmt(joinEta)} within ${fmt(budget)})` };
  if (c.improve && within(side, c.improve, guard)) {
    return { price: c.improve, reason: `improved best ${sideWord} by one tick (queue too slow: ${fmt(joinEta)})` };
  }
  return { price: c.join, reason: `joined best ${sideWord} (can't improve; expected ${fmt(joinEta)})` };
}

function fmt(sec: number): string {
  return Number.isFinite(sec) ? `${Math.round(sec)} s` : 'no recent fills';
}

export function decide(inp: StrategyInput): Decision {
  const { side, fallback, maxSlippageBps } = inp.params;
  if (inp.remaining.lte(0)) return { type: 'hold', reason: 'done' };

  if (inp.timeLeftSec <= 0) {
    if (fallback === 'market') return { type: 'cross', size: inp.remaining, reason: 'deadline reached, finishing the rest with a market order' };
    return { type: 'cancel', reason: 'deadline reached, cancelling the rest' };
  }

  const guard = priceGuard(side, inp.arrivalMid, maxSlippageBps, inp.tickSize);

  if (!inp.working) {
    const p = pick(inp, guard);
    return p ? { type: 'place', price: p.price, reason: p.reason } : { type: 'hold', reason: 'book is empty, waiting' };
  }

  // The book moved through our paper order without trading against it. Re-place it below the
  // new opposite price (no cooldown: a crossed order is not a valid resting order).
  if (inp.working.crossed) {
    const p = pick(inp, guard);
    if (p) return { type: 'replace', price: p.price, reason: `book moved through our price without a trade, ${p.reason}` };
    return { type: 'cancel', reason: 'book moved through our price and there is no valid price to rest at' };
  }

  if (inp.lastRepriceAt !== null && inp.now - inp.lastRepriceAt < REPRICE_COOLDOWN_MS) return { type: 'hold', reason: 'cooldown' };

  const w = inp.working.price;
  const own = side === 'buy' ? inp.bestBid : inp.bestAsk;
  const sideWord = side === 'buy' ? 'bid' : 'ask';

  // Someone is now at a better price than us.
  if (own && better(side, own, w)) {
    if (!within(side, own, guard)) {
      if (better(side, guard, w)) return { type: 'replace', price: guard, reason: `price moved past your limit, moved to your limit ${guard}` };
      return { type: 'hold', reason: `price moved past your limit ${guard}, holding` };
    }
    const p = pick(inp, guard);
    if (p && !p.price.eq(w)) return { type: 'replace', price: p.price, reason: `price moved away, ${p.reason}` };
    return { type: 'hold', reason: 'holding' };
  }

  // At the best price but the queue is too slow: improve if we can.
  const c = candidates(inp);
  const eta = inp.estimate(w, true);
  if (eta > 2 * inp.timeLeftSec && c.improve && better(side, c.improve, w) && within(side, c.improve, guard)) {
    return { type: 'replace', price: c.improve, reason: `queue too slow (${fmt(eta)}), moved up one tick` };
  }
  return { type: 'hold', reason: `at best ${sideWord}` };
}
