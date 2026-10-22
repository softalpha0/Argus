import { describe, expect, it } from 'vitest';
import { assembleSignedTx, bytesToHex, encodeHead, hexToBytes, mergeWitnessSets, skipItem } from '../../web/src/lib/cbor.js';

describe('Cardano CBOR splicing', () => {
  it('skips nested items, including indefinite and tagged ones', () => {
    // [1, h'0102', {0: "a"}, 258([5]), true]
    const hex = '85' + '01' + '420102' + 'a1' + '00' + '6161' + 'd90102' + '81' + '05' + 'f5';
    const b = hexToBytes(hex);
    expect(skipItem(b, 0)).toBe(b.length);
    expect(skipItem(hexToBytes('9f0102ff'), 0)).toBe(4);
    expect(bytesToHex(encodeHead(4, 300))).toBe('99012c');
  });

  it('keeps the body bytes and drops the wallet witness into an empty witness set', () => {
    const body = 'a300818258200000000000000000000000000000000000000000000000000000000000000000000181820a00021a0002a5a5';
    const tx = '84' + body + 'a0' + 'f5' + 'f6';
    const walletWits = 'a10081825820' + '11'.repeat(32) + '5840' + '22'.repeat(64);
    const signed = assembleSignedTx(tx, walletWits);
    expect(signed.startsWith('84' + body)).toBe(true);
    expect(signed).toBe('84' + body + walletWits + 'f5f6');
  });

  it('merges vkey witnesses and keeps other witness entries', () => {
    const w1 = '82' + '5820' + 'aa'.repeat(32) + '5840' + 'bb'.repeat(64);
    const w2 = '82' + '5820' + 'cc'.repeat(32) + '5840' + 'dd'.repeat(64);
    // tx has {0: 258([w1]), 5: [redeemer-ish]} ; wallet gives {0: [w2]}
    const txWits = hexToBytes('a2' + '00' + 'd90102' + '81' + w1 + '05' + '8100');
    const merged = bytesToHex(mergeWitnessSets(txWits, hexToBytes('a1' + '00' + '81' + w2)));
    expect(merged).toBe('a2' + '00' + 'd90102' + '82' + w1 + w2 + '05' + '8100');
  });

  it('rejects things that are not transactions', () => {
    expect(() => assembleSignedTx('a0', 'a0')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();
  });
});
