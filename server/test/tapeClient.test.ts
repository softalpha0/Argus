import { describe, expect, it } from 'vitest';
import { parseTrade } from '../src/strike/tapeClient.js';

describe('parseTrade', () => {
  it('parses a live trade frame', () => {
    // Captured from mainnet; t matched the L3 trade_id of the same fill.
    const t = parseTrade({ E: 1792555207016, T: 1792555206941, e: 'trade', m: false, p: '82613', q: '0.00349', s: 'BTC-USD', t: 2205523 });
    expect(t).not.toBeNull();
    expect(t!.id).toBe(2205523);
    expect(t!.price.toString()).toBe('82613');
    expect(t!.size.toString()).toBe('0.00349');
    expect(t!.buyerMaker).toBe(false);
  });

  it('ignores acks and malformed frames', () => {
    expect(parseTrade({ id: 1, result: null })).toBeNull();
    expect(parseTrade({ e: 'trade', p: 1, q: '1', t: 1 })).toBeNull();
  });
});
