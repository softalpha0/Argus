import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses defaults and reports live mode as not configured', () => {
    const c = loadConfig({});
    expect(c.env).toBe('mainnet');
    expect(c.symbol).toBe('BTC-USD');
    expect(c.port).toBe(8080);
    expect(c.argusFeeBps).toBe(2);
    expect(c.builderMaxFeeBps).toBe(10);
    expect(c.hosts.userWs).toBe('wss://api-v2.strikefinance.org/ws/user-api');
    expect(c.liveConfigured).toBe(false);
    expect(c.liveNotConfiguredReason).toMatch(/BUILDER_CODE and ARGUS_MASTER_KEY/);
  });

  it('enables live mode with builder code and master key', () => {
    const c = loadConfig({ BUILDER_CODE: 'ARGUS', ARGUS_MASTER_KEY: 'ab'.repeat(32), STRIKE_ENV: 'testnet' });
    expect(c.liveConfigured).toBe(true);
    expect(c.hosts.rest).toBe('https://api-v2-testnet.strikefinance.org');
  });

  it('rejects bad values', () => {
    expect(() => loadConfig({ STRIKE_ENV: 'devnet' })).toThrow();
    expect(() => loadConfig({ ARGUS_MASTER_KEY: 'short' })).toThrow();
    expect(() => loadConfig({ ARGUS_FEE_BPS: '20' })).toThrow(/BUILDER_MAX_FEE_BPS/);
  });
});
