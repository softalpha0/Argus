import crypto from 'node:crypto';
import type { DocStore } from '../db/DocStore.js';
import type { ApiWalletKey } from '../strike/rest.js';

export interface StoredUser {
  address: string;
  /** Older records predate Cardano support and are Solana. */
  chain?: 'solana' | 'cardano';
  accountId: string;
  apiWalletId: string;
  publicKey: string;
  feeShareBps: number;
  createdAt: number;
  /** When Strike expires this API wallet (Unix ms), if Strike said. */
  expiresAt?: number;
  /** AES-256-GCM over the 32-byte seed, all hex. */
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * API wallet keys, encrypted at rest with ARGUS_MASTER_KEY (AES-256-GCM).
 * The address is bound in as associated data, so a record can't be moved to another user.
 */
export class KeyStore {
  private readonly key: Buffer;
  private users = new Map<string, StoredUser>();

  /** `collection` is e.g. "keys" or "testnet/keys"; call init() before use. */
  constructor(private readonly db: DocStore, private readonly collection: string, masterKeyHex: string) {
    this.key = Buffer.from(masterKeyHex, 'hex');
    if (this.key.length !== 32) throw new Error('ARGUS_MASTER_KEY must be 32 bytes');
  }

  static async open(db: DocStore, collection: string, masterKeyHex: string): Promise<KeyStore> {
    const k = new KeyStore(db, collection, masterKeyHex);
    await k.init();
    return k;
  }

  async init(): Promise<void> {
    this.users = await this.db.loadAll<StoredUser>(this.collection);
  }

  save(u: Omit<StoredUser, 'iv' | 'tag' | 'ciphertext'>, secretKey: Uint8Array): Promise<void> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(u.address));
    const ct = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
    const rec = { ...u, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ct.toString('hex') };
    this.users.set(u.address, rec);
    return this.db.put(this.collection, u.address, rec);
  }

  get(address: string): StoredUser | undefined {
    return this.users.get(address);
  }

  /** Decrypts in memory only. Never log the result. */
  unlock(address: string): ApiWalletKey | undefined {
    const u = this.users.get(address);
    if (!u) return undefined;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(u.iv, 'hex'));
    decipher.setAAD(Buffer.from(u.address));
    decipher.setAuthTag(Buffer.from(u.tag, 'hex'));
    const seed = Buffer.concat([decipher.update(Buffer.from(u.ciphertext, 'hex')), decipher.final()]);
    return { publicKey: u.publicKey, secretKey: new Uint8Array(seed) };
  }

  async remove(address: string): Promise<void> {
    if (this.users.delete(address)) await this.db.remove(this.collection, address);
  }
}
