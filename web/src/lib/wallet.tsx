import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import bs58 from 'bs58';
import { api, ApiError, type Me } from './api';
import { connectCardano, listCardanoWallets, type CardanoWalletInfo } from './cardano';

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  }
}

function getPhantom(): PhantomProvider | null {
  const p = window.phantom?.solana ?? window.solana;
  return p?.isPhantom ? p : null;
}

interface WalletState {
  me: Me | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  hasPhantom: boolean;
  cardanoWallets: CardanoWalletInfo[];
  /** 'phantom' for Solana, or a Cardano wallet id from cardanoWallets. */
  connect(wallet?: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/api/me'));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [cardanoWallets, setCardanoWallets] = useState<CardanoWalletInfo[]>([]);
  useEffect(() => {
    // Wallet extensions inject themselves shortly after load.
    const scan = () => setCardanoWallets(listCardanoWallets());
    scan();
    const t = window.setTimeout(scan, 1000);
    return () => window.clearTimeout(t);
  }, []);

  const connect = useCallback(
    async (wallet = 'phantom') => {
      setError(null);
      setBusy(true);
      try {
        let address: string;
        let chain: 'solana' | 'cardano';
        let sign: (message: string) => Promise<string>;
        if (wallet === 'phantom') {
          const phantom = getPhantom();
          if (!phantom) {
            window.open('https://phantom.app/', '_blank', 'noopener');
            throw new Error('Phantom is not installed. Install it, then reload this page.');
          }
          const { publicKey } = await phantom.connect();
          address = publicKey.toString();
          chain = 'solana';
          sign = async (m) => bs58.encode((await phantom.signMessage(new TextEncoder().encode(m), 'utf8')).signature);
        } else {
          const c = await connectCardano(wallet);
          address = c.address;
          chain = 'cardano';
          sign = c.sign;
        }
        // Server makes a trade-only key and asks Strike for the consent text.
        const start = await api<{ nonce: string; message_to_sign: string }>('/api/connect/start', { method: 'POST', json: { address, chain } });
        const signature = await sign(start.message_to_sign);
        await api('/api/connect/finish', { method: 'POST', json: { address, nonce: start.nonce, signature } });
        await refresh();
      } catch (e) {
        const err = e as { message?: string; info?: string; code?: number };
        const msg = err.message ?? err.info ?? String(e);
        setError(/reject|cancel|declin|denied/i.test(msg) || err.code === 2 || err.code === -3 ? 'You cancelled the signature request.' : msg);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api('/api/connect/logout', { method: 'POST' }).catch(() => undefined);
    await getPhantom()?.disconnect().catch(() => undefined);
    setMe(null);
  }, []);

  return <Ctx.Provider value={{ me, loading, busy, error, hasPhantom: !!getPhantom(), cardanoWallets, connect, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

export const shortAddress = (a: string) => (a.startsWith('addr') ? `${a.slice(0, a.indexOf('1') + 5)}…${a.slice(-4)}` : `${a.slice(0, 4)}…${a.slice(-4)}`);
