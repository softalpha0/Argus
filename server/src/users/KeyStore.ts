import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiWalletKey } from '../strike/rest.js';

export interface StoredUser {
  address: string;
  accountId: string;
  apiWalletId: string;
  publicKey: string;
  feeShareBps: number;
  createdAt: number;
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
  private readonly file: string;
  private readonly key: Buffer;
  private users = new Map<string, StoredUser>();

  constructor(dataDir: string, masterKeyHex: string) {
    this.key = Buffer.from(masterKeyHex, 'hex');
    if (this.key.length !== 32) throw new Error('ARGUS_MASTER_KEY must be 32 bytes');
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'keys.json');
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, StoredUser>;
      for (const [k, v] of Object.entries(raw)) this.users.set(k, v);
    }
  }

  save(u: Omit<StoredUser, 'iv' | 'tag' | 'ciphertext'>, secretKey: Uint8Array): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(u.address));
    const ct = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
    this.users.set(u.address, { ...u, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ct.toString('hex') });
    this.flush();
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

  remove(address: string): void {
    if (this.users.delete(address)) this.flush();
  }

  private flush(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.users), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
