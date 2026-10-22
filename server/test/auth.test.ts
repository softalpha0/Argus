import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { generateApiWallet, normalizeSecretKey, sha256Hex, signHex, signingMessage, StrikeRest } from '../src/strike/rest.js';
import { KeyStore } from '../src/users/KeyStore.js';
import { Sessions } from '../src/users/Sessions.js';
import { logonMessage, splitFrames } from '../src/strike/userStream.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-'));

describe('request signing', () => {
  it('builds the message Strike expects and hashes the empty body for GET', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(signingMessage('get', '/v2/order?symbol=BTC-USD&client_order_id=a', 1700000000, 'n-1', '')).toBe(
      'GET:/v2/order?symbol=BTC-USD&client_order_id=a:1700000000:n-1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('signatures verify against the public key, and 64-byte keys use the first 32 bytes', async () => {
    const k = await generateApiWallet();
    expect(k.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const sig = await signHex('hello', k.secretKey);
    expect(await ed.verifyAsync(hexToBytes(sig), utf8ToBytes('hello'), hexToBytes(k.publicKey))).toBe(true);
    const long = new Uint8Array(64);
    long.set(k.secretKey);
    expect(normalizeSecretKey(long)).toEqual(k.secretKey);
    expect(() => normalizeSecretKey(new Uint8Array(10))).toThrow();
  });

  it('sends exactly the signed body with all four headers and the builder fee', async () => {
    const k = await generateApiWallet();
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ client_order_id: 'c' }), { status: 201 });
    }) as unknown as typeof fetch;
    const rest = new StrikeRest({ baseUrl: 'https://x', fetchFn, now: () => 1_700_000_000_123 }, k);
    await rest.createOrder({ symbol: 'BTC-USD', side: 'buy', type: 'limit', size: '0.001', price: '80000', time_in_force: 'GTC', post_only: true, client_order_id: 'c' }, 2);
    const h = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe('https://x/v2/order');
    expect(h['X-Builder-Fee-Bps']).toBe('2');
    expect(h['X-API-Wallet-Timestamp']).toBe('1700000000');
    expect(h['X-API-Wallet-Public-Key']).toBe(k.publicKey);
    const msg = signingMessage('POST', '/v2/order', 1700000000, h['X-API-Wallet-Nonce']!, seen!.init.body as string);
    expect(await ed.verifyAsync(hexToBytes(h['X-API-Wallet-Signature']!), utf8ToBytes(msg), hexToBytes(k.publicKey))).toBe(true);
  });

  it('turns Strike errors into readable messages', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: 'builder fee exceeds approved fee share' }), { status: 400 })) as unknown as typeof fetch;
    const rest = new StrikeRest({ baseUrl: 'https://x', fetchFn }, await generateApiWallet());
    await expect(rest.cancelOrder(1, 'BTC-USD')).rejects.toMatchObject({ status: 400, message: 'builder fee exceeds approved fee share' });
  });
});

describe('KeyStore', () => {
  it('encrypts at rest and decrypts only with the right key and address', async () => {
    const dir = tmp();
    const master = 'ab'.repeat(32);
    const k = await generateApiWallet();
    const store = new KeyStore(dir, master);
    store.save({ address: 'Wallet1', accountId: 'acc', apiWalletId: '7', publicKey: k.publicKey, feeShareBps: 10, createdAt: 1 }, k.secretKey);
    const raw = fs.readFileSync(path.join(dir, 'keys.json'), 'utf8');
    expect(raw).not.toContain(Buffer.from(k.secretKey).toString('hex'));
    expect(new KeyStore(dir, master).unlock('Wallet1')!.secretKey).toEqual(k.secretKey);
    expect(() => new KeyStore(dir, 'cd'.repeat(32)).unlock('Wallet1')).toThrow();
    // Moving the record to another address breaks authentication.
    const j = JSON.parse(raw);
    j.Wallet2 = { ...j.Wallet1, address: 'Wallet2' };
    fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(j));
    expect(() => new KeyStore(dir, master).unlock('Wallet2')).toThrow();
  });
});

describe('Sessions', () => {
  it('stores only token hashes and expires sessions', () => {
    const dir = tmp();
    let now = 1000;
    const s = new Sessions(dir, () => now);
    const { token } = s.create('W', 'acc');
    expect(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).not.toContain(token);
    expect(new Sessions(dir, () => now).get(token)?.address).toBe('W');
    now += 8 * 24 * 3600_000;
    expect(s.get(token)).toBeUndefined();
    expect(s.get(undefined)).toBeUndefined();
  });
});

describe('user stream helpers', () => {
  it('splits newline-batched frames and skips bad lines', () => {
    expect(splitFrames('{"a":1}\n{"b":2}\nnope\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it('builds the logon message', () => {
    expect(logonMessage(1700000000000, 'abc')).toBe('session.logon:1700000000000:abc');
  });
});

describe('wallet address checks', async () => {
  const { checkAddress } = await import('../src/users/Accounts.js');
  const main = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
  const test = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
  it('accepts Solana and Cardano addresses on the right network', () => {
    expect(checkAddress('solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'mainnet')).toBeNull();
    expect(checkAddress('cardano', main, 'mainnet')).toBeNull();
    expect(checkAddress('cardano', test, 'testnet')).toBeNull();
  });
  it('explains network mismatches and bad addresses', () => {
    expect(checkAddress('cardano', test, 'mainnet')).toMatch(/testnet/);
    expect(checkAddress('cardano', main, 'testnet')).toMatch(/Mainnet/);
    expect(checkAddress('cardano', '0xabc', 'mainnet')).toMatch(/Cardano payment address/);
    expect(checkAddress('solana', main, 'mainnet')).toMatch(/Solana/);
  });
});

describe('deposit amounts', async () => {
  const { toSmallestUnit } = await import('../src/api/funds.js');
  it('converts to the smallest unit exactly', () => {
    expect(toSmallestUnit('3000', 6)).toBe('3000000000');
    expect(toSmallestUnit('0.5', 9)).toBe('500000000');
    expect(toSmallestUnit('12.345678', 6)).toBe('12345678');
  });
  it('rejects bad amounts', () => {
    expect(() => toSmallestUnit('0', 6)).toThrow(/greater than 0/);
    expect(() => toSmallestUnit('abc', 6)).toThrow(/number/);
    expect(() => toSmallestUnit('1.0000001', 6)).toThrow(/decimal places/);
  });
});
