import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { OrderBook, type L3Update } from '../src/book/OrderBook.js';
import { MarketModel } from '../src/model/MarketModel.js';
import { parseSymbolRules } from '../src/strike/exchangeInfo.js';
import type { Exchange, MarketData, MarketEvents } from '../src/exchange/Exchange.js';

export const rules = parseSymbolRules(
  {
    symbols: [{ symbol: 'BTC-USD', status: 'trading', filters: [
      { filterType: 'PRICE_FILTER', maxPrice: '1000000', minPrice: '10', tickSize: '1' },
      { filterType: 'LOT_SIZE', maxQty: '1000', minQty: '0.00001', stepSize: '0.00001' },
      { filterType: 'MIN_NOTIONAL', notional: '10' },
    ] }],
  },
  'BTC-USD',
);

export type FakeExchange = Exchange & {
  createLiveVenue: ReturnType<typeof vi.fn>;
  /** Applies an order-level update to the book and tells listeners, like a live feed. */
  send(p: Partial<L3Update>): void;
};

/**
 * An exchange with a real order book (best bid 100,000 holding `bidSize`, best ask 100,001;
 * mid 100,000.5) and a live venue that only records that it was reached.
 */
export function fakeExchange(opts: { now?: number; bidSize?: string } = {}): FakeExchange {
  const now = opts.now ?? Date.now();
  const book = new OrderBook();
  book.loadSnapshot({
    type: 'l3_snapshot', symbol: 'BTC-USD', last_sequence: 0, timestamp: now,
    bids: [{ price: '100000', orders: [{ order_id: 'b1', size: opts.bidSize ?? '0.5' }] }],
    asks: [{ price: '100001', orders: [{ order_id: 'a1', size: '0.5' }] }],
  });
  const model = new MarketModel(book);
  model.markStart(now);
  const market = Object.assign(new EventEmitter<MarketEvents>(), {
    symbol: 'BTC-USD', book, model, isLive: true, rules, recentTrades: () => [], health: () => ({ sync: { state: 'live' } }),
  }) as MarketData;
  let seq = 0;
  return {
    id: 'fake', name: 'Fake', market, start: async () => {}, stop: () => {},
    createLiveVenue: vi.fn(async () => { throw new Error('live venue reached'); }),
    send(p) {
      const u = { type: 'l3_update', symbol: 'BTC-USD', sequence: ++seq, timestamp: Date.now(), ...p } as L3Update;
      const res = book.apply(u);
      if (!res.ok) throw new Error(`bad test update: ${JSON.stringify(res)}`);
      model.onUpdate(u, res);
      market.emit('update', u, res);
    },
  };
}
