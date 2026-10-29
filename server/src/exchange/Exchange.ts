import type { EventEmitter } from 'node:events';
import type { Decimal } from 'decimal.js';
import type { ApplyResult, L3Update, OrderBook } from '../book/OrderBook.js';
import type { MarketModel } from '../model/MarketModel.js';
import type { Venue } from '../engine/Venue.js';

/** Trading rules for one market: price and size increments and minimums. */
export interface MarketRules {
  symbol: string;
  status: string;
  tickSize: Decimal;
  minPrice: Decimal;
  maxPrice: Decimal;
  stepSize: Decimal;
  minQty: Decimal;
  maxQty: Decimal;
  marketMaxQty: Decimal;
  minNotional: Decimal;
}

/** A trade from the exchange's public tape. */
export interface PublicTrade {
  id: number | string;
  price: Decimal;
  size: Decimal;
  time: number;
  /** True means the buyer was the maker, i.e. a seller took liquidity. */
  buyerMaker: boolean;
}

export interface MarketEvents {
  /** One order-level change applied to the local book (the model has already seen it). */
  update: [L3Update, ApplyResult];
  /** The book was rebuilt from a fresh snapshot. */
  synced: [];
  /** Feed state changed (connected, resyncing, live). */
  state: [];
}

/** Public market data for one symbol, kept in sync order by order. */
export interface MarketData extends EventEmitter<MarketEvents> {
  readonly symbol: string;
  readonly book: OrderBook;
  readonly model: MarketModel;
  /** True while the book is in sync and safe to trade against. */
  readonly isLive: boolean;
  readonly rules: MarketRules | null;
  recentTrades(limit: number): readonly PublicTrade[];
  /** Feed diagnostics for /api/market. */
  health(): Record<string, unknown>;
}

/**
 * Everything Argus needs from one exchange. The execution engine and the API
 * depend only on this, so adding an exchange means adding an adapter.
 */
export interface Exchange {
  /** Short stable ID, e.g. "strike". */
  readonly id: string;
  readonly name: string;
  readonly market: MarketData;
  /** A venue that places real orders for a connected user, or throws with a user-facing message. */
  createLiveVenue(owner: string, executionId: string): Promise<Venue>;
  /** Connects feeds and loads fees; returns once the server can start serving. */
  start(): Promise<void>;
  stop(): void;
}
