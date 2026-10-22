export interface BookOrder { id: string; size: string }
export interface BookLevel { price: string; total: string; orders: BookOrder[] }
export interface Market {
  symbol: string;
  live: boolean;
  sequence: number;
  mid: string | null;
  spread: string | null;
  fillRate: { buy: number; sell: number };
  rules: { tickSize: string; stepSize: string; minQty: string; minNotional: string } | null;
  book: { bids: BookLevel[]; asks: BookLevel[] } | null;
  recentTrades: { id: number; price: string; size: string; time: number; buyerMaker: boolean }[];
}

export interface FillChecks { bestPrice?: string; firstInLine?: string; onTape?: string; linked?: boolean; note?: string; pending?: boolean }
export interface ExecFill { ts: number; orderId: string; size: string; price: string; isMaker: boolean; fee: string; builderFee?: string; tradeId?: number; checks?: FillChecks }
export interface ExecEvent { ts: number; text: string; kind: 'info' | 'action' | 'fill' | 'warn' | 'error' }
export interface ReportStep { n: number; label: string; formula: string; value: string }
export interface Report {
  side: 'buy' | 'sell';
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
  savings: string | null;
  savingsBps: string | null;
  makerShare: string;
  makerSize: string;
  steps: ReportStep[];
  notes: string[];
}

export interface Execution {
  id: string;
  mode: 'paper' | 'live';
  side: 'buy' | 'sell';
  size: string;
  deadlineSec: number;
  maxSlippageBps: number;
  preset: string;
  fallback: string;
  state: 'working' | 'finishing' | 'done' | 'canceled' | 'failed';
  createdAt: number;
  endedAt: number | null;
  deadline: number;
  timeLeftSec: number;
  arrivalMid: string;
  limitPrice: string;
  filled: string;
  working: { id: string; price: string; size: string; filled: string; queue: { place: number | null; sizeAhead: string; estimating: boolean; etaSec: number | null } | null } | null;
  status: string | null;
  fills: ExecFill[];
  events: ExecEvent[];
  error: string | null;
  report: Report | null;
  audit?: { orders?: { clientOrderId: string; id?: number; status?: string; builder?: { Code: string; FeeBps: number } | null; error?: string }[] } | null;
}

export interface Stats {
  total: StatBucket;
  paper: StatBucket;
  live: StatBucket;
  series: { ts: number; mode: string; notionalUsd: string; savedUsd: string; makerShare: string }[];
}
export interface StatBucket {
  executions: number;
  withFills: number;
  volumeBtc: string;
  notionalUsd: string;
  makerShare: string;
  savedUsd: string;
  savedBps: string;
  argusFeesUsd: string;
  strikeFeesUsd: string;
}

export const isFinished = (e: Execution) => e.state === 'done' || e.state === 'canceled' || e.state === 'failed';
