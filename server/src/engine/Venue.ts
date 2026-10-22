import type { Decimal } from 'decimal.js';
import type { EventEmitter } from 'node:events';
import type { Side } from '../book/OrderBook.js';

export interface WorkingOrder {
  /** Venue-local ID (client order ID for live). */
  id: string;
  side: Side;
  price: Decimal;
  size: Decimal;
  filled: Decimal;
  placedAt: number;
  /** Numeric Strike order ID once known (live only). */
  exchangeId?: number;
  /** Public L3 ID once linked (live only). */
  publicId?: string;
  done: boolean;
}

export interface Fill {
  orderId: string;
  size: Decimal;
  price: Decimal;
  isMaker: boolean;
  /** Strike fee in quote currency. Negative is a rebate. */
  fee: Decimal;
  /** Builder fee Strike charged on this fill (live only, from the user stream). */
  builderFee?: Decimal;
  tradeId?: number;
  ts: number;
  /** Fairness checks (live only); filled in shortly after the fill, then `update` fires. */
  checks?: Record<string, unknown>;
}

export interface QueuePosition {
  /** Place in line at our price, 1-based. Undefined while estimating. */
  place?: number;
  /** Size that must trade before us, including better prices. */
  sizeAhead: Decimal;
  estimating: boolean;
}

export interface PlaceParams {
  side: Side;
  price: Decimal;
  size: Decimal;
  clientId: string;
}

export interface CrossParams {
  side: Side;
  size: Decimal;
  /** Decimal fraction, e.g. 0.001 = 0.1%. */
  slippage: Decimal;
  clientId: string;
}

export class PostOnlyRejected extends Error {
  constructor(msg = 'Post-only order would have crossed the book') {
    super(msg);
    this.name = 'PostOnlyRejected';
  }
}

export interface VenueEvents {
  fill: [Fill];
  /** Order finished: fully filled, cancelled or rejected by the venue. */
  orderDone: [WorkingOrder, 'filled' | 'canceled' | 'rejected'];
  error: [Error];
  /** Something shown in the execution view changed (e.g. fairness checks arrived). */
  update: [];
}

/** What an Execution needs from a venue. Paper and live both implement it. */
export interface Venue extends EventEmitter<VenueEvents> {
  readonly mode: 'paper' | 'live';
  place(p: PlaceParams): Promise<WorkingOrder>;
  /** Cancel and re-place at a new price. Loses queue priority. */
  replace(order: WorkingOrder, p: PlaceParams): Promise<WorkingOrder>;
  cancel(order: WorkingOrder): Promise<void>;
  /** Market order for the remainder. Resolves after fills are known. */
  cross(p: CrossParams): Promise<Fill[]>;
  queuePosition(order: WorkingOrder): QueuePosition;
  /** Optional proof from the exchange after the run (live: each order as Strike reports it). */
  audit?(): Promise<unknown>;
  close(): void;
}
