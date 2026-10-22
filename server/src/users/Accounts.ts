import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { generateApiWallet, StrikeRest, StrikeError, type ApiWalletKey, type WalletChain } from '../strike/rest.js';
import { UserStream } from '../strike/userStream.js';
import { KeyStore } from './KeyStore.js';
import { Sessions } from './Sessions.js';

interface Pending {
  address: string;
  chain: WalletChain;
  key: ApiWalletKey;
  expiresAt: number;
}

const PENDING_TTL_MS = 5 * 60_000;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Bech32 payment addresses: addr1… on mainnet, addr_test1… on testnets.
const CARDANO_ADDRESS = /^(addr|addr_test)1[02-9ac-hj-np-z]{50,120}$/;
// CIP-30 signData result, joined as {coseSign1Hex}:{coseKeyHex}.
const CARDANO_SIGNATURE = /^[0-9a-fA-F]+:[0-9a-fA-F]+$/;

/** Checks an address for the given chain and network; returns an error message or null. */
export function checkAddress(chain: WalletChain, address: string, env: 'mainnet' | 'testnet'): string | null {
  if (chain === 'solana') return SOLANA_ADDRESS.test(address) ? null : 'That does not look like a Solana wallet address';
  if (!CARDANO_ADDRESS.test(address)) return 'That does not look like a Cardano payment address (addr1… or addr_test1…)';
  const isTest = address.startsWith('addr_test1');
  if (env === 'mainnet' && isTest) return 'Your Cardano wallet is on a testnet. Switch it to Mainnet, or run Argus with STRIKE_ENV=testnet.';
  if (env === 'testnet' && !isTest) return 'Your Cardano wallet is on Mainnet. Switch it to the testnet Strike uses, or run Argus with STRIKE_ENV=mainnet.';
  return null;
}

/** Strike's api_wallet_expired_at as Unix ms (accepts seconds, ms or an ISO string). */
export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export class ConnectError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Builder Connect onboarding, stored API wallets, sessions and per-user streams. */
export class Accounts {
  readonly sessions: Sessions;
  private readonly keys: KeyStore | null;
  private readonly rest: StrikeRest;
  private pending = new Map<string, Pending>();
  private streams = new Map<string, UserStream>();

  constructor(private readonly config: Config, private readonly logger: Logger) {
    // Each network has its own Strike accounts and API wallets; keep them apart.
    const dir = config.env === 'mainnet' ? config.dataDir : path.join(config.dataDir, config.env);
    this.sessions = new Sessions(dir);
    this.keys = config.masterKey ? new KeyStore(dir, config.masterKey) : null;
    this.rest = new StrikeRest({ baseUrl: config.hosts.rest });
  }

  private requireLive(): KeyStore {
    if (!this.config.liveConfigured || !this.keys) throw new ConnectError(this.config.liveNotConfiguredReason ?? 'Live mode is not configured', 503);
    return this.keys;
  }

  /** Step 1: make a fresh API wallet and ask Strike for the consent message. */
  async start(address: unknown, chainIn: unknown = 'solana'): Promise<{ nonce: string; message_to_sign: string }> {
    this.requireLive();
    const chain = chainIn ?? 'solana';
    if (chain !== 'solana' && chain !== 'cardano') throw new ConnectError('chain must be "solana" or "cardano"');
    if (typeof address !== 'string') throw new ConnectError('Missing wallet address');
    const bad = checkAddress(chain, address, this.config.env);
    if (bad) throw new ConnectError(bad);
    this.prunePending();
    if (this.pending.size > 1000) throw new ConnectError('Too many sign-ins in progress, try again in a minute', 429);
    const key = await generateApiWallet();
    let res;
    try {
      res = await this.rest.requestSignature({
        address,
        chain,
        code: this.config.builderCode!,
        fee_share_bps: this.config.builderMaxFeeBps,
        public_key: key.publicKey,
      });
    } catch (err) {
      throw this.wrap(err, 'Strike could not start the connection');
    }
    this.pending.set(res.nonce, { address, chain, key, expiresAt: Date.now() + PENDING_TTL_MS });
    return { nonce: res.nonce, message_to_sign: res.message_to_sign };
  }

  /** Step 2: hand Strike the wallet signature, store the trading key, open a session. */
  async finish(address: unknown, nonce: unknown, signature: unknown): Promise<{ token: string; address: string; accountId: string }> {
    const keys = this.requireLive();
    if (typeof nonce !== 'string' || typeof signature !== 'string' || typeof address !== 'string') throw new ConnectError('Missing address, nonce or signature');
    const p = this.pending.get(nonce);
    if (!p || p.expiresAt < Date.now() || p.address !== address) throw new ConnectError('This sign-in expired. Please try again.');
    this.pending.delete(nonce);
    if (p.chain === 'cardano' && !CARDANO_SIGNATURE.test(signature)) throw new ConnectError('The Cardano signature is not in the expected {coseSign1}:{coseKey} format');
    let res;
    try {
      // The challenge already carries address and chain; send only what Strike's reference sends.
      res = await this.rest.verifySignature({ nonce, wallet_signature: signature });
    } catch (err) {
      throw this.wrap(err, 'Strike did not accept the signature');
    }
    if (res.api_wallet_public_key && res.api_wallet_public_key.toLowerCase() !== p.key.publicKey.toLowerCase()) {
      throw new ConnectError('Strike linked a different key than the one we generated; not saving it', 502);
    }
    // Replacing an earlier key: stop its stream first.
    this.streams.get(address)?.stop();
    this.streams.delete(address);
    keys.save(
      {
        address,
        chain: p.chain,
        accountId: res.account_id,
        apiWalletId: String(res.api_wallet_id),
        publicKey: p.key.publicKey,
        feeShareBps: Number(res.fee_share_bps ?? this.config.builderMaxFeeBps),
        createdAt: Date.now(),
        expiresAt: toMs(res.api_wallet_expired_at),
      },
      p.key.secretKey,
    );
    const { token } = this.sessions.create(address, res.account_id);
    this.logger.info({ address, accountId: res.account_id }, 'wallet connected');
    return { token, address, accountId: res.account_id };
  }

  user(address: string) {
    return this.keys?.get(address);
  }

  /** Signed REST client for a connected user. */
  restFor(address: string): StrikeRest {
    const u = this.keys?.get(address);
    if (u?.expiresAt && u.expiresAt <= Date.now()) throw new ConnectError("Argus's trading key for your account has expired. Disconnect and connect your wallet again.", 401);
    const key = this.requireLive().unlock(address);
    if (!key) throw new ConnectError('Connect your wallet first', 401);
    return this.rest.withKey(key);
  }

  /** Shared, lazily opened user stream. */
  streamFor(address: string): UserStream {
    let s = this.streams.get(address);
    if (s) return s;
    const key = this.requireLive().unlock(address);
    if (!key) throw new ConnectError('Connect your wallet first', 401);
    s = new UserStream(this.config.hosts.userWs, key, this.logger.child({ mod: 'user-stream', address }));
    s.on('down', (reason) => this.logger.warn({ address, reason }, 'user stream down'));
    s.start();
    this.streams.set(address, s);
    return s;
  }

  async summary(address: string) {
    const u = this.user(address);
    if (!u) return null;
    let balances: unknown = null;
    let balanceError: string | null = null;
    try {
      balances = await this.restFor(address).getBalances();
    } catch (err) {
      balanceError = (err as Error).message;
    }
    return { address, chain: u.chain ?? 'solana', network: this.config.env, accountId: u.accountId, apiWalletPublicKey: u.publicKey, feeShareBps: u.feeShareBps, connectedAt: u.createdAt, keyExpiresAt: u.expiresAt ?? null, balances, balanceError };
  }

  stop(): void {
    for (const s of this.streams.values()) s.stop();
    this.streams.clear();
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [n, p] of this.pending) if (p.expiresAt < now) this.pending.delete(n);
  }

  private wrap(err: unknown, prefix: string): ConnectError {
    if (err instanceof StrikeError && /own builder code/i.test(err.message)) {
      return new ConnectError(
        `This wallet's Strike account owns the builder code "${this.config.builderCode}", and Strike does not let a builder trade through its own code. Connect with a different wallet or account.`,
        400,
      );
    }
    if (err instanceof StrikeError) return new ConnectError(`${prefix}: ${err.message}`, err.status >= 500 || err.status === 0 ? 502 : 400);
    return new ConnectError(`${prefix}: ${(err as Error).message}`, 502);
  }
}
