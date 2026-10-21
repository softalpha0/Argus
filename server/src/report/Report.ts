import { Decimal } from 'decimal.js';
import type { Side } from '../book/OrderBook.js';

export interface ReportFill {
  size: Decimal;
  price: Decimal;
  isMaker: boolean;
  fee: Decimal;
}

export interface BookLevelLite {
  price: Decimal;
  size: Decimal;
}

export interface ReportInput {
  side: Side;
  requestedSize: Decimal;
  arrivalMid: Decimal;
  fills: ReportFill[];
  argusFeeBps: number;
  takerFee: Decimal;
  /** Opposite side of the book at arrival, best first. Used for the market-order baseline. */
  arrivalOpposite: BookLevelLite[];
}

export interface ReportStep {
  n: number;
  label: string;
  formula: string;
  value: string;
}

export interface ExecutionReport {
  side: Side;
  requestedSize: string;
  filledSize: string;
  arrivalMid: string;
  avgPrice: string | null;
  notional: string;
  priceCost: string;
  strikeFees: string;
  argusFee: string;
  totalCost: string;
  baselineAvg: string | null;
  baselineCost: string | null;
  baselineShortfall: string;
  savings: string | null;
  savingsBps: string | null;
  makerShare: string;
  makerSize: string;
  steps: ReportStep[];
  notes: string[];
}

const ZERO = new Decimal(0);
const usd = (d: Decimal) => d.toDecimalPlaces(6).toString();
const usd2 = (d: Decimal) => (d.isNeg() ? '−$' : '$') + d.abs().toFixed(d.abs().lt(1) && !d.isZero() ? 4 : 2);

/** Average price of taking `qty` from `levels` (best first). */
export function walkBook(levels: BookLevelLite[], qty: Decimal): { avg: Decimal | null; filled: Decimal } {
  let left = qty;
  let cost = ZERO;
  for (const l of levels) {
    if (left.lte(0)) break;
    const take = Decimal.min(left, l.size);
    cost = cost.plus(take.mul(l.price));
    left = left.minus(take);
  }
  const filled = qty.minus(left);
  return { avg: filled.gt(0) ? cost.div(filled) : null, filled };
}

/**
 * Savings math, written so every step can be shown in the UI.
 * Costs are positive when bad for the user; for sells the price terms flip sign.
 */
export function buildReport(inp: ReportInput): ExecutionReport {
  const sign = inp.side === 'buy' ? 1 : -1;
  const Q = inp.fills.reduce((s, f) => s.plus(f.size), ZERO);
  const notional = inp.fills.reduce((s, f) => s.plus(f.size.mul(f.price)), ZERO);
  const makerSize = inp.fills.filter((f) => f.isMaker).reduce((s, f) => s.plus(f.size), ZERO);
  const strikeFees = inp.fills.reduce((s, f) => s.plus(f.fee), ZERO);
  const argusFee = notional.mul(inp.argusFeeBps).div(10_000);
  const notes: string[] = [];

  const avg = Q.gt(0) ? notional.div(Q) : null;
  const priceCost = avg ? avg.minus(inp.arrivalMid).mul(Q).mul(sign) : ZERO;
  const totalCost = priceCost.plus(strikeFees).plus(argusFee);

  const walk = Q.gt(0) ? walkBook(inp.arrivalOpposite, Q) : { avg: null, filled: ZERO };
  const shortfall = Q.minus(walk.filled);
  let baselineCost: Decimal | null = null;
  if (walk.avg) {
    // If the stored book was thinner than Q, price the rest at the last level we saw. Flag it.
    baselineCost = walk.avg.minus(inp.arrivalMid).mul(walk.filled).mul(sign).plus(walk.avg.mul(walk.filled).mul(inp.takerFee));
    if (shortfall.gt(0)) {
      const last = inp.arrivalOpposite.at(-1)!.price;
      baselineCost = baselineCost.plus(last.minus(inp.arrivalMid).mul(shortfall).mul(sign)).plus(last.mul(shortfall).mul(inp.takerFee));
      notes.push(`The stored book at arrival only covered ${walk.filled} BTC; the remaining ${shortfall} BTC is priced at the deepest level seen.`);
    }
  }
  const savings = baselineCost ? baselineCost.minus(totalCost) : null;
  const savingsBps = savings && notional.gt(0) ? savings.div(notional).mul(10_000) : null;
  const makerShare = Q.gt(0) ? makerSize.div(Q) : ZERO;

  if (Q.isZero()) notes.push('Nothing filled, so there is nothing to compare.');
  else if (Q.lt(inp.requestedSize)) notes.push(`Only ${Q} of ${inp.requestedSize} BTC filled. The comparison covers the filled part.`);

  const pcWord = inp.side === 'buy' ? '(avg − arrival mid) × Q' : '(arrival mid − avg) × Q';
  const steps: ReportStep[] = [
    { n: 1, label: 'Average price', formula: `Σ(price × size) / Q = ${usd(notional)} / ${Q}`, value: avg ? avg.toDecimalPlaces(2).toString() : '—' },
    { n: 2, label: 'Price cost vs arrival', formula: `${pcWord} = ${avg ? `(${inp.side === 'buy' ? `${avg.toDecimalPlaces(4)} − ${inp.arrivalMid}` : `${inp.arrivalMid} − ${avg.toDecimalPlaces(4)}`}) × ${Q}` : '—'}`, value: usd2(priceCost) },
    { n: 3, label: 'Strike fees (negative = rebate)', formula: 'Σ fee on each fill', value: usd2(strikeFees) },
    { n: 4, label: 'Argus fee', formula: `${usd(notional)} × ${inp.argusFeeBps} / 10000`, value: usd2(argusFee) },
    { n: 5, label: 'Total cost', formula: 'price cost + Strike fees + Argus fee', value: usd2(totalCost) },
    {
      n: 6,
      label: 'Market order at arrival',
      formula: walk.avg ? `walk arrival book: avg ${walk.avg.toDecimalPlaces(4)}; price cost + ${Q} × avg × ${inp.takerFee} taker fee` : '—',
      value: baselineCost ? usd2(baselineCost) : '—',
    },
    { n: 7, label: 'You saved', formula: 'market cost − total cost', value: savings ? `${usd2(savings)} (${savingsBps!.toDecimalPlaces(2)} bps)` : '—' },
    { n: 8, label: 'Filled as maker', formula: `${makerSize} / ${Q}`, value: Q.gt(0) ? `${makerShare.mul(100).toDecimalPlaces(1)}%` : '—' },
  ];

  return {
    side: inp.side,
    requestedSize: inp.requestedSize.toString(),
    filledSize: Q.toString(),
    arrivalMid: inp.arrivalMid.toString(),
    avgPrice: avg ? usd(avg) : null,
    notional: usd(notional),
    priceCost: usd(priceCost),
    strikeFees: usd(strikeFees),
    argusFee: usd(argusFee),
    totalCost: usd(totalCost),
    baselineAvg: walk.avg ? usd(walk.avg) : null,
    baselineCost: baselineCost ? usd(baselineCost) : null,
    baselineShortfall: shortfall.toString(),
    savings: savings ? usd(savings) : null,
    savingsBps: savingsBps ? savingsBps.toDecimalPlaces(4).toString() : null,
    makerShare: makerShare.toDecimalPlaces(6).toString(),
    makerSize: makerSize.toString(),
    steps,
    notes,
  };
}
