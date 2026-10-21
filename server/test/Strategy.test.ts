import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { decide, priceGuard, type StrategyInput } from '../src/engine/Strategy.js';

const D = (v: string | number) => new Decimal(v);

function input(over: Partial<StrategyInput> = {}, params: Partial<StrategyInput['params']> = {}): StrategyInput {
  return {
    params: { side: 'buy', maxSlippageBps: 10, preset: 'balanced', fallback: 'market', ...params },
    arrivalMid: D(100_000),
    tickSize: D(1),
    bestBid: D(99_999),
    bestAsk: D(100_001),
    remaining: D('0.01'),
    timeLeftSec: 300,
    now: 10_000,
    lastRepriceAt: null,
    working: null,
    estimate: () => 60,
    ...over,
  };
}

describe('priceGuard', () => {
  it('caps buys above and sells below arrival, rounded inside the limit', () => {
    expect(priceGuard('buy', D('100000.5'), 10, D(1)).toString()).toBe('100100');
    expect(priceGuard('sell', D('100000.5'), 10, D(1)).toString()).toBe('99901');
  });
});

describe('decide', () => {
  it('joins when the queue fills within the patience budget', () => {
    const d = decide(input({ estimate: () => 100 })); // budget 300 * 0.6 = 180
    expect(d).toMatchObject({ type: 'place' });
    if (d.type === 'place') expect(d.price.toString()).toBe('99999');
  });

  it('improves by one tick when the queue is too slow and the spread allows it', () => {
    const d = decide(input({ estimate: () => 200 }));
    expect(d.type).toBe('place');
    if (d.type === 'place') expect(d.price.toString()).toBe('100000');
  });

  it('patience presets change the choice', () => {
    expect((decide(input({ estimate: () => 200 }, { preset: 'patient' })) as any).price.toString()).toBe('99999'); // 270 budget
    expect((decide(input({ estimate: () => 100 }, { preset: 'fast' })) as any).price.toString()).toBe('100000'); // 90 budget
  });

  it('never improves with a 1-tick spread (it would cross)', () => {
    const d = decide(input({ bestAsk: D(100_000), estimate: () => Infinity }));
    if (d.type !== 'place') throw new Error(d.type);
    expect(d.price.toString()).toBe('99999');
    expect(d.reason).toMatch(/can't improve/);
  });

  it('does not improve past the price guard', () => {
    const d = decide(input({ arrivalMid: D(99_999), bestBid: D(100_008), bestAsk: D(100_010), estimate: () => Infinity }, { maxSlippageBps: 1 }));
    // guard = floor(99999 * 1.0001) = 100008; improve would be 100009
    if (d.type !== 'place') throw new Error(d.type);
    expect(d.price.toString()).toBe('100008');
  });

  it('waits at the limit when best bid is already past it', () => {
    const d = decide(input({ bestBid: D(100_200), bestAsk: D(100_202) }));
    if (d.type !== 'place') throw new Error(d.type);
    expect(d.price.toString()).toBe('100100');
  });

  it('mirrors everything for sells', () => {
    const d = decide(input({ estimate: () => 200 }, { side: 'sell' }));
    if (d.type !== 'place') throw new Error(d.type);
    expect(d.price.toString()).toBe('100000');
    const j = decide(input({ estimate: () => 10 }, { side: 'sell' }));
    expect((j as any).price.toString()).toBe('100001');
  });

  it('sits one tick inside the opposite side when its own side is empty', () => {
    const d = decide(input({ bestBid: undefined }));
    expect((d as any).price.toString()).toBe('100000');
    expect(decide(input({ bestBid: undefined, bestAsk: undefined })).type).toBe('hold');
  });

  it('reprices when someone is now better and the new best is within the guard', () => {
    const d = decide(input({ working: { price: D(99_990) }, estimate: () => 10 }));
    expect(d.type).toBe('replace');
    if (d.type === 'replace') expect(d.price.toString()).toBe('99999');
  });

  it('holds instead of chasing past the guard', () => {
    const d = decide(input({ working: { price: D(100_100) }, bestBid: D(100_150), bestAsk: D(100_152) }));
    expect(d.type).toBe('hold');
    const m = decide(input({ working: { price: D(100_050) }, bestBid: D(100_150), bestAsk: D(100_152) }));
    expect(m).toMatchObject({ type: 'replace' });
    expect((m as any).price.toString()).toBe('100100');
  });

  it('holds at the best price when the queue is fine', () => {
    const d = decide(input({ working: { price: D(99_999) }, estimate: () => 50 }));
    expect(d.type).toBe('hold');
  });

  it('moves up a tick when at best but expected fill > 2x time left', () => {
    const d = decide(input({ working: { price: D(99_999) }, estimate: () => 700 }));
    expect(d.type).toBe('replace');
    if (d.type === 'replace') expect(d.price.toString()).toBe('100000');
    // Not when the spread is 1 tick.
    expect(decide(input({ working: { price: D(99_999) }, bestAsk: D(100_000), estimate: () => 700 })).type).toBe('hold');
  });

  it('applies the 2 s reprice cooldown', () => {
    const d = decide(input({ working: { price: D(99_990) }, lastRepriceAt: 9_000, now: 10_000 }));
    expect(d).toEqual({ type: 'hold', reason: 'cooldown' });
    expect(decide(input({ working: { price: D(99_990) }, lastRepriceAt: 8_000, now: 10_000 })).type).toBe('replace');
  });

  it('re-places a crossed paper order right away, ignoring cooldown', () => {
    const d = decide(input({ working: { price: D(100_001), crossed: true }, lastRepriceAt: 9_900, bestBid: D(99_998), bestAsk: D(100_000), estimate: () => 10 }));
    expect(d.type).toBe('replace');
    if (d.type === 'replace') expect(d.price.toString()).toBe('99998');
  });

  it('at the deadline crosses the remainder or cancels', () => {
    const c = decide(input({ timeLeftSec: 0, working: { price: D(99_999) } }));
    expect(c.type).toBe('cross');
    if (c.type === 'cross') expect(c.size.toString()).toBe('0.01');
    expect(decide(input({ timeLeftSec: -1 }, { fallback: 'cancel' })).type).toBe('cancel');
  });
});
