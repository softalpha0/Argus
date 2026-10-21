import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import bs58 from 'bs58';
import { api, ApiError, type Me } from './api';

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
  connect(): Promise<void>;
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

  const connect = useCallback(async () => {
    setError(null);
    const phantom = getPhantom();
    if (!phantom) {
      window.open('https://phantom.app/', '_blank', 'noopener');
      setError('Phantom is not installed. Install it, then reload this page.');
      return;
    }
    setBusy(true);
    try {
      const { publicKey } = await phantom.connect();
      const address = publicKey.toString();
      // Server makes a trade-only key and asks Strike for the consent text.
      const start = await api<{ nonce: string; message_to_sign: string }>('/api/connect/start', { method: 'POST', json: { address } });
      const { signature } = await phantom.signMessage(new TextEncoder().encode(start.message_to_sign), 'utf8');
      await api('/api/connect/finish', { method: 'POST', json: { address, nonce: start.nonce, signature: bs58.encode(signature) } });
      await refresh();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(/reject|cancel/i.test(msg) ? 'You cancelled the signature request.' : msg);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/api/connect/logout', { method: 'POST' }).catch(() => undefined);
    await getPhantom()?.disconnect().catch(() => undefined);
    setMe(null);
  }, []);

  return <Ctx.Provider value={{ me, loading, busy, error, hasPhantom: !!getPhantom(), connect, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
