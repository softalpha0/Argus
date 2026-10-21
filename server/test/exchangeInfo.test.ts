import { describe, expect, it } from 'vitest';
import { checkOrder, parseSymbolRules, roundPrice, roundSize } from '../src/strike/exchangeInfo.js';

// Shape copied from the live mainnet response on 2026-10-21.
const info = {
  symbols: [
    {
      symbol: 'BTC-USD',
      status: 'trading',
      filters: [
        { filterType: 'PRICE_FILTER', maxPrice: '100000', minPrice: '10', tickSize: '1' },
        { filterType: 'LOT_SIZE', maxQty: '1000', minQty: '0.00001', stepSize: '0.00001' },
        { filterType: 'MARKET_LOT_SIZE', maxQty: '120', minQty: '0.00001', stepSize: '0.00001' },
        { filterType: 'MIN_NOTIONAL', notional: '10' },
      ],
    },
  ],
};

describe('exchangeInfo', () => {
  const r = parseSymbolRules(info, 'BTC-USD');

  it('parses filters', () => {
    expect(r.tickSize.toString()).toBe('1');
    expect(r.minQty.toString()).toBe('0.00001');
    expect(r.minNotional.toString()).toBe('10');
    expect(r.marketMaxQty.toString()).toBe('120');
  });

  it('rounds prices to ticks in the safe direction and sizes down', () => {
    expect(roundPrice(r, '82630.7', 'down').toString()).toBe('82630');
    expect(roundPrice(r, '82630.2', 'up').toString()).toBe('82631');
    expect(roundSize(r, '0.0012345').toString()).toBe('0.00123');
  });

  it('rejects orders that break the rules with a clear message', () => {
    expect(checkOrder(r, '0.001', '82630')).toBeNull();
    expect(checkOrder(r, '0.0001', '82630')).toMatch(/below Strike's minimum of \$10/);
    expect(checkOrder(r, '0.000001', '82630')).toMatch(/multiple of 0.00001/);
    expect(checkOrder(r, '0.001', '82630.5')).toMatch(/multiple of 1/);
    expect(checkOrder(r, '200', '82630', 'market')).toMatch(/maximum of 120/);
  });

  it('throws on missing symbol', () => {
    expect(() => parseSymbolRules(info, 'ETH-USD')).toThrow(/not listed/);
  });
});
