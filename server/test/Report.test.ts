import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { buildReport, walkBook } from '../src/report/Report.js';

const D = (v: string | number) => new Decimal(v);

describe('Report', () => {
  it('matches the README example: $10,000 buy filled fully as maker at arrival', () => {
    // Q = 0.1 BTC at 100,000; arrival mid 100,000; ask side at 100,000.
    const r = buildReport({
      side: 'buy',
      requestedSize: D('0.1'),
      arrivalMid: D(100_000),
      fills: [{ size: D('0.1'), price: D(100_000), isMaker: true, fee: D(10_000).mul('-0.00005') }],
      argusFeeBps: 2,
      takerFee: D('0.0005'),
      arrivalOpposite: [{ price: D(100_000), size: D(5) }],
    });
    expect(r.strikeFees).toBe('-0.5');
    expect(r.argusFee).toBe('2');
    expect(r.totalCost).toBe('1.5');
    expect(r.baselineCost).toBe('5');
    expect(r.savings).toBe('3.5');
    expect(r.savingsBps).toBe('3.5');
    expect(r.makerShare).toBe('1');
    expect(r.steps).toHaveLength(8);
  });

  it('counts price moves and spread, and mirrors for sells', () => {
    const r = buildReport({
      side: 'sell',
      requestedSize: D('1'),
      arrivalMid: D(100),
      fills: [
        { size: D('0.6'), price: D(101), isMaker: true, fee: D('-0.00303') },
        { size: D('0.4'), price: D(99), isMaker: false, fee: D('0.0198') },
      ],
      argusFeeBps: 2,
      takerFee: D('0.0005'),
      arrivalOpposite: [{ price: D('99.5'), size: D('0.5') }, { price: D(99), size: D(10) }],
    });
    // avg = (60.6 + 39.6) / 1 = 100.2; sell price cost = (100 − 100.2) × 1 = −0.2 (good)
    expect(r.avgPrice).toBe('100.2');
    expect(r.priceCost).toBe('-0.2');
    // baseline avg = 99.25; cost = (100 − 99.25) + 99.25 × 0.0005 = 0.799625
    expect(r.baselineAvg).toBe('99.25');
    expect(r.baselineCost).toBe('0.799625');
    // total = −0.2 + 0.01677 + 100.2 × 0.0002 = −0.16319
    expect(r.totalCost).toBe('-0.16319');
    expect(r.savings).toBe('0.962815');
    expect(r.makerShare).toBe('0.6');
  });

  it('handles nothing filled and partial fills honestly', () => {
    const none = buildReport({ side: 'buy', requestedSize: D(1), arrivalMid: D(100), fills: [], argusFeeBps: 2, takerFee: D('0.0005'), arrivalOpposite: [] });
    expect(none.savings).toBeNull();
    expect(none.notes[0]).toMatch(/Nothing filled/);
    const part = buildReport({
      side: 'buy', requestedSize: D(1), arrivalMid: D(100), argusFeeBps: 0, takerFee: D('0.0005'),
      fills: [{ size: D('0.5'), price: D(100), isMaker: true, fee: D(0) }],
      arrivalOpposite: [{ price: D(101), size: D('0.2') }],
    });
    expect(part.notes.join(' ')).toMatch(/Only 0.5 of 1 BTC filled/);
    expect(part.notes.join(' ')).toMatch(/only covered 0.2 BTC/);
    expect(part.baselineCost).toBe('0.52525');
  });

  it('walkBook averages across levels', () => {
    expect(walkBook([{ price: D(10), size: D(1) }, { price: D(20), size: D(1) }], D('1.5')).avg!.toString()).toBe('13.333333333333333333');
  });
});
