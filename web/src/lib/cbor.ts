/**
 * Minimal CBOR byte surgery for Cardano transactions.
 *
 * CIP-30 `signTx` returns only a witness set. To submit, it must be merged into the
 * transaction's own witness set. The transaction body must keep its exact bytes, because
 * the signature covers the body hash, so we splice raw bytes instead of decoding and
 * re-encoding the whole transaction.
 */

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.trim();
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('Invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

interface Head {
  major: number;
  /** Argument value; -1 for indefinite length. */
  value: number;
  /** Offset just past the head. */
  next: number;
}

function readHead(b: Uint8Array, at: number): Head {
  const first = b[at];
  if (first === undefined) throw new Error('CBOR: unexpected end');
  const major = first >> 5;
  const info = first & 31;
  if (info < 24) return { major, value: info, next: at + 1 };
  if (info === 31) return { major, value: -1, next: at + 1 };
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (!size) throw new Error('CBOR: bad additional info');
  let v = 0;
  for (let i = 0; i < size; i++) {
    const byte = b[at + 1 + i];
    if (byte === undefined) throw new Error('CBOR: unexpected end');
    v = v * 256 + byte;
  }
  return { major, value: v, next: at + 1 + size };
}

/** Offset just past the CBOR item starting at `at`. */
export function skipItem(b: Uint8Array, at: number): number {
  const h = readHead(b, at);
  const BREAK = 0xff;
  switch (h.major) {
    case 0:
    case 1:
      return h.next;
    case 2:
    case 3:
      if (h.value >= 0) return h.next + h.value;
      {
        let p = h.next;
        while (b[p] !== BREAK) p = skipItem(b, p);
        return p + 1;
      }
    case 4:
    case 5: {
      let p = h.next;
      const per = h.major === 5 ? 2 : 1;
      if (h.value >= 0) {
        for (let i = 0; i < h.value * per; i++) p = skipItem(b, p);
        return p;
      }
      while (b[p] !== BREAK) p = skipItem(b, p);
      return p + 1;
    }
    case 6:
      return skipItem(b, h.next);
    case 7:
      return h.next; // simple values and floats carry no further items
    default:
      throw new Error('CBOR: bad major type');
  }
}

export function encodeHead(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Items of a definite or indefinite array/map, as raw byte slices. */
function items(b: Uint8Array, at: number): { major: number; parts: Uint8Array[]; end: number } {
  const h = readHead(b, at);
  if (h.major !== 4 && h.major !== 5) throw new Error('CBOR: expected array or map');
  const parts: Uint8Array[] = [];
  let p = h.next;
  const count = h.value >= 0 ? h.value * (h.major === 5 ? 2 : 1) : Infinity;
  for (let i = 0; i < count && !(h.value < 0 && b[p] === 0xff); i++) {
    const e = skipItem(b, p);
    parts.push(b.slice(p, e));
    p = e;
  }
  return { major: h.major, parts, end: h.value < 0 ? p + 1 : p };
}

/** Array elements, unwrapping an optional set tag (258). Returns the tag bytes to re-wrap with. */
function listOf(raw: Uint8Array): { tag: Uint8Array | null; elems: Uint8Array[] } {
  const h = readHead(raw, 0);
  if (h.major === 6) return { tag: raw.slice(0, h.next), elems: items(raw, h.next).parts };
  return { tag: null, elems: items(raw, 0).parts };
}

function mergeLists(a: Uint8Array, b: Uint8Array): Uint8Array {
  const x = listOf(a);
  const y = listOf(b);
  const elems = [...x.elems, ...y.elems];
  const arr = concat(encodeHead(4, elems.length), ...elems);
  const tag = x.tag ?? y.tag;
  return tag ? concat(tag, arr) : arr;
}

/** Merge two witness-set maps; vkey witnesses (key 0) and bootstrap witnesses (key 2) are concatenated. */
export function mergeWitnessSets(txWits: Uint8Array, walletWits: Uint8Array): Uint8Array {
  const entries = new Map<number, Uint8Array[]>(); // key -> [rawKey, rawValue]
  const add = (raw: Uint8Array, mergeable: boolean) => {
    const { parts } = items(raw, 0);
    for (let i = 0; i < parts.length; i += 2) {
      const k = readHead(parts[i]!, 0).value;
      const prev = entries.get(k);
      if (prev && mergeable && (k === 0 || k === 2)) entries.set(k, [prev[0]!, mergeLists(prev[1]!, parts[i + 1]!)]);
      else if (!prev) entries.set(k, [parts[i]!, parts[i + 1]!]);
    }
  };
  add(txWits, false);
  add(walletWits, true);
  const keys = [...entries.keys()].sort((a, b) => a - b);
  return concat(encodeHead(5, keys.length), ...keys.flatMap((k) => entries.get(k)!));
}

/** Put the wallet's witness set into the transaction, keeping the body bytes untouched. */
export function assembleSignedTx(txHex: string, walletWitnessHex: string): string {
  const tx = hexToBytes(txHex);
  const { major, parts } = items(tx, 0);
  if (major !== 4 || parts.length < 2) throw new Error('Not a Cardano transaction');
  parts[1] = mergeWitnessSets(parts[1]!, hexToBytes(walletWitnessHex));
  return bytesToHex(concat(encodeHead(4, parts.length), ...parts));
}
