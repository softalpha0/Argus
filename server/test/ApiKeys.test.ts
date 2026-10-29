import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileDocStore } from '../src/db/DocStore.js';
import { ApiKeys, DEFAULT_LIMITS, parseLimits } from '../src/users/ApiKeys.js';
import { AuthError, makeAuth } from '../src/api/auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-keys-'));

async function keys(dir = tmp()) {
  const k = new ApiKeys(new FileDocStore(dir), 'api-keys');
  await k.init();
  return { k, dir };
}

describe('ApiKeys', () => {
  it('shows the key once and stores only its hash', async () => {
    const { k, dir } = await keys();
    const { key, apiKey } = await k.create('W1', { name: 'my bot' });
    expect(key).toMatch(/^argus_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(apiKey).toMatchObject({ name: 'my bot', limits: DEFAULT_LIMITS, prefix: `argus_${apiKey.id}_…` });
    expect(apiKey).not.toHaveProperty('hash');
    expect(fs.readFileSync(path.join(dir, 'api-keys.json'), 'utf8')).not.toContain(key.split('_')[2]);
    // Survives a restart.
    const { k: again } = await keys(dir);
    expect(again.verify(key)?.owner).toBe('W1');
  });

  it('rejects wrong, malformed and revoked keys', async () => {
    const { k } = await keys();
    const { key, apiKey } = await k.create('W1', {});
    expect(k.verify(key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A'))).toBeUndefined();
    expect(k.verify('nonsense')).toBeUndefined();
    expect(await k.revoke('someone-else', apiKey.id)).toBeUndefined();
    expect(k.verify(key)).toBeDefined();
    expect((await k.revoke('W1', apiKey.id))?.revokedAt).toBeTypeOf('number');
    expect(k.verify(key)).toBeUndefined();
    expect(k.list('W1')[0]!.revokedAt).toBeTypeOf('number');
    expect(k.list('W2')).toEqual([]);
  });

  it('validates limits and caps the number of active keys', async () => {
    expect(parseLimits({})).toEqual(DEFAULT_LIMITS);
    expect(parseLimits({ maxOrderUsd: '250.555', dailyUsd: 1000 })).toEqual({ maxOrderUsd: 250.56, dailyUsd: 1000 });
    expect(() => parseLimits({ maxOrderUsd: -1 })).toThrow(/positive/);
    expect(() => parseLimits({ dailyUsd: 'lots' })).toThrow(/positive/);
    expect(() => parseLimits({ maxOrderUsd: 5_000_000 })).toThrow(/at most/);
    expect(() => parseLimits({ maxOrderUsd: 600, dailyUsd: 500 })).toThrow(/cannot be larger/);
    const { k } = await keys();
    for (let i = 0; i < 10; i++) await k.create('W1', {});
    await expect(k.create('W1', {})).rejects.toThrow(/at most 10/);
    await k.revoke('W1', k.list('W1')[0]!.id);
    await expect(k.create('W1', {})).resolves.toBeDefined();
  });
});

describe('makeAuth', () => {
  const req = (headers: Record<string, string>, cookies: Record<string, string> = {}) => ({ headers, cookies }) as never;

  it('accepts a session cookie or a valid API key, and refuses a bad key outright', async () => {
    const { k } = await keys();
    const { key } = await k.create('W1', {});
    const accounts = { sessions: { get: (t?: string) => (t === 'good' ? { address: 'W2' } : undefined) } } as never;
    const auth = makeAuth(accounts, k, 'testnet');
    expect(auth.caller(req({}))).toBeNull();
    expect(auth.caller(req({}, { argus_session_testnet: 'good' }))).toEqual({ owner: 'W2', via: 'session' });
    expect(auth.caller(req({ authorization: `Bearer ${key}` }))).toMatchObject({ owner: 'W1', via: 'apiKey' });
    expect(() => auth.caller(req({ authorization: 'Bearer argus_000000000000_' + 'x'.repeat(43) }))).toThrow(AuthError);
    expect(() => auth.caller(req({ authorization: 'Basic abc' }))).toThrow(/Bearer/);
    // Funds and key management only ever look at the session.
    expect(auth.sessionOwner(req({ authorization: `Bearer ${key}` }))).toBeNull();
  });
});
