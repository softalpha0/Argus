import { bech32 } from 'bech32';

/** CIP-30 wallet API, the parts Argus uses. */
interface Cip30Api {
  getNetworkId(): Promise<number>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  signData(addressHex: string, payloadHex: string): Promise<{ signature: string; key: string }>;
  getUtxos(amount?: string, paginate?: unknown): Promise<string[] | null>;
  signTx(txHex: string, partialSign?: boolean): Promise<string>;
  submitTx(txHex: string): Promise<string>;
}

interface Cip30Wallet {
  name: string;
  icon: string;
  apiVersion?: string;
  enable(): Promise<Cip30Api>;
}

declare global {
  interface Window {
    cardano?: Record<string, Cip30Wallet | unknown>;
  }
}

export interface CardanoWalletInfo {
  id: string;
  name: string;
  icon: string;
}

// Keys that are not wallets on window.cardano.
const IGNORE = new Set(['_events', '_eventsCount', '_maxListeners']);

export function listCardanoWallets(): CardanoWalletInfo[] {
  const c = window.cardano;
  if (!c) return [];
  const seen = new Set<string>();
  const out: CardanoWalletInfo[] = [];
  for (const [id, w] of Object.entries(c)) {
    if (IGNORE.has(id) || !w || typeof w !== 'object') continue;
    const wallet = w as Cip30Wallet;
    if (typeof wallet.enable !== 'function' || typeof wallet.name !== 'string') continue;
    // Some wallets register under several keys; show each name once.
    if (seen.has(wallet.name)) continue;
    seen.add(wallet.name);
    out.push({ id, name: wallet.name, icon: wallet.icon });
  }
  return out;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/** bech32 address to raw bytes (hex), as CIP-30 signData expects. */
export function bech32ToHex(address: string): string {
  return toHex(new Uint8Array(bech32.fromWords(bech32.decode(address, 1000).words)));
}

/** Raw address bytes (hex) to bech32: addr1… on mainnet (network id 1), addr_test1… otherwise. */
export function addressToBech32(hex: string): string {
  const bytes = fromHex(hex);
  const networkId = bytes[0]! & 0x0f;
  const prefix = networkId === 1 ? 'addr' : 'addr_test';
  return bech32.encode(prefix, bech32.toWords(bytes), 1000);
}

export interface CardanoSession {
  walletId: string;
  address: string;
  addressHex: string;
  networkId: number;
  /** Sign a UTF-8 message (Builder Connect). Returns {coseSign1}:{coseKey}. */
  sign(message: string): Promise<string>;
  /** Sign a payload that is already hex (Strike's withdrawal message). */
  signHex(payloadHex: string): Promise<string>;
  utxos(): Promise<string[]>;
  /** Sign a transaction; returns the wallet's witness set (hex). */
  signTx(txHex: string): Promise<string>;
  submitTx(txHex: string): Promise<string>;
}

const STORE_KEY = 'argus.cardanoWallet';
export const rememberCardanoWallet = (id: string) => {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    /* storage unavailable */
  }
};
export const rememberedCardanoWallet = (): string | null => {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
};

export async function connectCardano(walletId: string): Promise<CardanoSession> {
  const w = window.cardano?.[walletId] as Cip30Wallet | undefined;
  if (!w) throw new Error('That Cardano wallet is no longer available. Reload the page.');
  const api = await w.enable();
  const networkId = await api.getNetworkId();
  const used = await api.getUsedAddresses();
  const raw = used[0] ?? (await api.getChangeAddress());
  if (!raw) throw new Error('Your Cardano wallet did not share an address');
  // Some wallets return the address already in bech32; signData wants hex bytes.
  const address = raw.startsWith('addr') ? raw : addressToBech32(raw);
  const addressHex = raw.startsWith('addr') ? bech32ToHex(raw) : raw;
  rememberCardanoWallet(walletId);
  return {
    walletId,
    address,
    addressHex,
    networkId,
    async sign(message: string) {
      const payload = toHex(new TextEncoder().encode(message));
      const { signature, key } = await api.signData(addressHex, payload);
      return `${signature}:${key}`;
    },
    async signHex(payloadHex: string) {
      const { signature, key } = await api.signData(addressHex, payloadHex);
      return `${signature}:${key}`;
    },
    async utxos() {
      return (await api.getUtxos()) ?? [];
    },
    signTx: (txHex) => api.signTx(txHex, true),
    submitTx: (txHex) => api.submitTx(txHex),
  };
}
