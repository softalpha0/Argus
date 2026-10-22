import { describe, expect, it } from 'vitest';
import { parseBaseFees } from '../src/strike/feeTiers.js';
import { loadConfig } from '../src/config.js';

describe('parseBaseFees', () => {
  it('reads tier 0 as plain decimal strings', () => {
    const body = { feeTiers: [{ Tier: 1, MinVolume: 100000, TakerRate: 0.00045, MakerRate: -0.00005 }, { Tier: 0, MinVolume: 0, TakerRate: 0.0005, MakerRate: -0.00005 }] };
    expect(parseBaseFees(body)).toEqual({ takerFee: '0.0005', makerFee: '-0.00005' });
  });
  it('handles a zero maker rate (testnet)', () => {
    expect(parseBaseFees({ feeTiers: [{ Tier: 0, MinVolume: 0, TakerRate: 0.0005, MakerRate: 0 }] })).toEqual({ takerFee: '0.0005', makerFee: '0' });
  });
  it('rejects a body without tier 0', () => {
    expect(() => parseBaseFees({ feeTiers: [] })).toThrow();
    expect(() => parseBaseFees(null)).toThrow();
  });
});

describe('fee defaults', () => {
  it('defaults to no maker rebate on testnet and pins fees set in env', () => {
    expect(loadConfig({ STRIKE_ENV: 'testnet' }).makerFee).toBe('0');
    expect(loadConfig({ STRIKE_ENV: 'mainnet' }).makerFee).toBe('-0.00005');
    expect(loadConfig({ STRIKE_ENV: 'testnet' }).feesPinned).toBe(false);
    expect(loadConfig({ STRIKE_ENV: 'testnet', MAKER_FEE: '-0.0001' }).feesPinned).toBe(true);
  });
});
