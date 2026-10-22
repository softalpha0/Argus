import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { v4 as uuidv4 } from 'uuid';

export type WalletChain = 'solana' | 'cardano';

export class StrikeError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = 'StrikeError';
  }
}

export interface ApiWalletKey {
  /** 64 hex chars. */
  publicKey: string;
  /** 32-byte seed. A 64-byte key is cut to its first 32 bytes. */
  secretKey: Uint8Array;
}

export function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)));
}

/** Message Strike expects to be signed: `{METHOD}:{PATH_WITH_QUERY}:{TIMESTAMP}:{NONCE}:{SHA256_HEX_OF_BODY}`. */
export function signingMessage(method: string, pathWithQuery: string, timestampSec: number, nonce: string, body: string): string {
  return `${method.toUpperCase()}:${pathWithQuery}:${timestampSec}:${nonce}:${sha256Hex(body)}`;
}

export function normalizeSecretKey(key: Uint8Array | string): Uint8Array {
  const bytes = typeof key === 'string' ? hexToBytes(key) : key;
  if (bytes.length === 64) return bytes.slice(0, 32);
  if (bytes.length !== 32) throw new Error('API wallet key must be 32 or 64 bytes');
  return bytes;
}

export async function generateApiWallet(): Promise<ApiWalletKey> {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = bytesToHex(await ed.getPublicKeyAsync(secretKey));
  return { publicKey, secretKey };
}

/** Local clock minus Strike's clock, in ms. Strike rejects timestamps from the future. */
let clockSkewMs = 0;
export const getClockSkew = () => clockSkewMs;

export async function syncClock(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const t0 = Date.now();
  const res = await fetchFn(`${baseUrl}/v2/time`);
  const t1 = Date.now();
  if (!res.ok) throw new Error(`time HTTP ${res.status}`);
  const { serverTime } = (await res.json()) as { serverTime: number };
  clockSkewMs = (t0 + t1) / 2 - serverTime;
  return clockSkewMs;
}

export async function signHex(message: string, secretKey: Uint8Array): Promise<string> {
  return bytesToHex(await ed.signAsync(utf8ToBytes(message), normalizeSecretKey(secretKey)));
}

export interface RestOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  /** Clock in ms, injectable for tests and server-time correction. */
  now?: () => number;
  timeoutMs?: number;
}

export interface CreateOrderBody {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  size: string;
  price?: string;
  time_in_force?: 'GTC' | 'IOC' | 'FOK';
  post_only?: boolean;
  slippage?: string;
  client_order_id: string;
}

export interface CreateOrderResponse {
  client_order_id: string;
  account_id: string;
  symbol: string;
  sequence_id: number;
  message_id: string;
}

/** Strike REST client. Unauthenticated calls work without a key; signed calls need one. */
export class StrikeRest {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: RestOptions, private readonly key?: ApiWalletKey) {
    this.fetchFn = opts.fetchFn ?? fetch;
    // Never sign a timestamp ahead of Strike's clock: subtract any positive skew, plus a second of margin.
    this.now = opts.now ?? (() => Date.now() - Math.max(0, clockSkewMs) - 1000);
  }

  withKey(key: ApiWalletKey): StrikeRest {
    return new StrikeRest(this.opts, key);
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', pathWithQuery: string, body?: unknown, extraHeaders: Record<string, string> = {}, signed = true): Promise<T> {
    // Serialize once; the signed string is exactly what is sent.
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (signed) {
      if (!this.key) throw new Error('This request needs an API wallet key');
      const ts = Math.floor(this.now() / 1000);
      const nonce = uuidv4();
      headers['X-API-Wallet-Public-Key'] = this.key.publicKey;
      headers['X-API-Wallet-Timestamp'] = String(ts);
      headers['X-API-Wallet-Nonce'] = nonce;
      headers['X-API-Wallet-Signature'] = await signHex(signingMessage(method, pathWithQuery, ts, nonce, bodyStr), this.key.secretKey);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await this.fetchFn(this.opts.baseUrl + pathWithQuery, { method, headers, body: body === undefined ? undefined : bodyStr, signal: ctrl.signal });
    } catch (err) {
      throw new StrikeError(0, `Could not reach Strike: ${(err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const j = json as { error?: string; msg?: string; minimum_usd?: number } | undefined;
      const base = j?.error || j?.msg || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new StrikeError(res.status, j?.minimum_usd ? `${base} (minimum $${j.minimum_usd})` : base, json);
    }
    return json as T;
  }

  // Builder Connect (public)
  requestSignature(b: { address: string; chain: WalletChain; code: string; fee_share_bps: number; public_key: string }) {
    return this.request<{ nonce: string; message_to_sign: string }>('POST', '/auth/builder/request-signature', b, {}, false);
  }

  verifySignature(b: { nonce: string; wallet_signature: string }) {
    return this.request<{ account_id: string; builder_code: string; fee_share_bps: number; api_wallet_id: string | number; api_wallet_public_key: string; api_wallet_expired_at?: number | string; [k: string]: unknown }>(
      'POST',
      '/auth/builder/verify-signature',
      b,
      {},
      false,
    );
  }

  // Orders (signed, carry the builder fee)
  createOrder(o: CreateOrderBody, builderFeeBps: number) {
    return this.request<CreateOrderResponse>('POST', '/v2/order', o, { 'X-Builder-Fee-Bps': String(builderFeeBps) });
  }

  replaceOrder(cancel: { order_id: number; symbol: string }, newOrder: CreateOrderBody, builderFeeBps: number) {
    return this.request<CreateOrderResponse>('POST', '/v2/order/replace', { cancel, new_order: newOrder }, { 'X-Builder-Fee-Bps': String(builderFeeBps) });
  }

  cancelOrder(orderId: number, symbol: string) {
    return this.request<unknown>('DELETE', '/v2/order/cancel', { order_id: orderId, symbol });
  }

  getOrderByClientId(symbol: string, clientOrderId: string) {
    return this.request<Record<string, unknown>>('GET', `/v2/order?symbol=${encodeURIComponent(symbol)}&client_order_id=${encodeURIComponent(clientOrderId)}`);
  }

  getBalances() {
    return this.request<{ asset: string; walletBalance: string; availableBalance: string; unrealizedPnl: string; marginBalance: string }[]>('GET', '/v2/balances');
  }

  // Funds (signed). The deposit address and withdrawal recipient are fixed by Strike, never by us.
  depositQuote(b: { blockchain: WalletChain; asset_symbol: string; asset_amount: string }) {
    return this.request<{ request_id: string; quote: Record<string, unknown>; deposit_address: string; confirmations_required: number }>('POST', '/v2/deposit/quote', b);
  }

  depositBuildTx(b: { request_id: string; user_address: string; utxos?: string[] }) {
    return this.request<{ blockchain: string; unsigned_tx: unknown; format: string; expires_at?: number }>('POST', '/v2/deposit/build-tx', b);
  }

  depositConfirm(b: { request_id: string; tx_hash: string }) {
    return this.request<{ request_id: string; status: string; tx_hash: string; message?: string }>('POST', '/v2/deposit', b);
  }

  withdrawQuote(b: { blockchain: WalletChain; usd_value: string; asset?: string }) {
    return this.request<{ withdraw_id: string; fee: string; message_to_sign: string; tx_cbor?: string; validator_address?: string }>('POST', '/v2/withdraw/quote', b);
  }

  withdrawConfirm(b: { withdraw_id: string; wallet_signature: string; signed_tx_cbor?: string }) {
    return this.request<{ request_id: string; status: string }>('POST', '/v2/withdraw', b);
  }

  withdrawLimits(chain: WalletChain, asset: string) {
    return this.request<Record<string, unknown>>('GET', `/v2/withdraw/limits?chain=${chain}&asset=${encodeURIComponent(asset)}`);
  }

  getPositions() {
    return this.request<unknown>('GET', '/v2/positions');
  }
}
