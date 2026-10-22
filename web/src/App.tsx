import { useEffect, useState } from 'react';
import { WalletProvider, shortAddress, useWallet } from './lib/wallet';
import { LiveProvider, useLive } from './lib/live';
import { useRoute } from './lib/router';
import Trade from './pages/Trade';
import Execution from './pages/Execution';
import Report from './pages/Report';
import Stats from './pages/Stats';
import Landing from './pages/Landing';
import Docs from './pages/Docs';
import WalletModal from './components/WalletModal';
import FundsModal from './components/FundsModal';
import { useRef, useState as useLocalState } from 'react';

interface ServerConfig {
  env: string;
  symbol: string;
  argusFeeBps: number;
  takerFee: string;
  makerFee: string;
  liveConfigured: boolean;
  liveNotConfiguredReason: string | null;
}

function Header({ env }: { env: string }) {
  const { connected, market } = useLive();
  const { me, open, logout } = useWallet();
  const route = useRoute();
  const [menu, setMenu] = useLocalState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [setMenu]);
  const usdBal = me?.balances?.find((b) => /USD/.test(b.asset))?.availableBalance;
  const link = (href: string, label: string, on: boolean) => (
    <a href={href} className={`rounded-md px-3 py-1.5 text-sm ${on ? 'bg-ink-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100'}`}>{label}</a>
  );
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 pb-4">
      <a href="#/" className="flex items-center gap-2.5" aria-label="Argus home">
        <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
          <rect width="32" height="32" rx="7" fill="#111816" />
          <rect x="6" y="9" width="20" height="3" rx="1.5" fill="#f0627e" />
          <rect x="6" y="15" width="14" height="3" rx="1.5" fill="#f5b94a" />
          <rect x="6" y="21" width="20" height="3" rx="1.5" fill="#2fd39a" />
        </svg>
        <span className="text-lg font-semibold tracking-tight">Argus</span>
      </a>
      <nav className="flex items-center gap-1">
        {link('#/', 'Product', route.page === 'home')}
        {link('#/trade', 'Trade', route.page === 'trade' || route.page === 'execution' || route.page === 'report')}
        {link('#/docs', 'Docs', route.page === 'docs')}
        {link('#/stats', 'Stats', route.page === 'stats')}
      </nav>
      <div className="flex items-center gap-3 font-mono text-xs text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${connected && market?.live ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          {env} {market?.live ? 'L3 live' : 'syncing'}
        </span>
        {me ? (
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenu(!menu)} className="flex items-center gap-2 rounded-md bg-ink-800 px-2.5 py-1 text-neutral-100 hover:bg-ink-700" aria-expanded={menu}>
              <span>{shortAddress(me.address)}</span>
              {usdBal !== undefined && <span className="text-neutral-400">${Number(usdBal).toFixed(2)}</span>}
              <span aria-hidden>▾</span>
            </button>
            {menu && (
              <div className="absolute right-0 z-40 mt-2 grid w-48 gap-1 rounded-lg border border-ink-700 bg-ink p-1 font-sans text-sm shadow-xl">
                <span className="px-3 py-1.5 text-xs text-neutral-500">{me.chain === 'cardano' ? 'Cardano' : 'Solana'} · {me.network}</span>
                <button className="rounded px-3 py-1.5 text-left hover:bg-ink-800" onClick={() => { setMenu(false); open('deposit'); }}>Deposit</button>
                <button className="rounded px-3 py-1.5 text-left hover:bg-ink-800" onClick={() => { setMenu(false); open('withdraw'); }}>Withdraw</button>
                <button className="rounded px-3 py-1.5 text-left text-neutral-400 hover:bg-ink-800" onClick={() => { setMenu(false); void logout(); }}>Disconnect</button>
              </div>
            )}
          </div>
        ) : (
          <button onClick={() => open('connect')} className="rounded-md bg-maker px-3 py-1.5 font-sans text-sm font-medium text-ink hover:bg-[#4ce3ae]">Connect wallet</button>
        )}
      </div>
    </header>
  );
}

function Modals({ env }: { env: string }) {
  const { modal, open } = useWallet();
  if (modal === 'connect') return <WalletModal network={env} onClose={() => open(null)} />;
  if (modal === 'deposit' || modal === 'withdraw') return <FundsModal tab={modal} network={env} onClose={() => open(null)} />;
  return null;
}

function Body({ config }: { config: ServerConfig }) {
  const route = useRoute();
  if (route.page === 'execution') return <Execution id={route.id} />;
  if (route.page === 'report') return <Report id={route.id} />;
  if (route.page === 'stats') return <Stats />;
  if (route.page === 'docs') return <Docs section={route.section} />;
  if (route.page === 'trade') return <Trade config={config} />;
  return <Landing />;
}

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setConfig)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-4 py-6 sm:px-6">
      {error && <p className="text-red-400">Server not reachable: {error}</p>}
      {!error && !config && <p className="text-neutral-500">Connecting…</p>}
      {config && (
        <LiveProvider>
          <WalletProvider>
            <Header env={config.env} />
            <Body config={config} />
            <Modals env={config.env} />
            <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-ink-700 pt-6 text-sm text-neutral-500">
              <span>Argus · built for the Strike Finance hackathon, October 2026</span>
              <span className="flex flex-wrap gap-4">
                <a href="#/docs" className="hover:text-neutral-200">Docs</a>
                <a href="https://github.com/softalpha0/Argus" target="_blank" rel="noreferrer" className="hover:text-neutral-200">GitHub</a>
                <a href="https://docs.strikefinance.org" target="_blank" rel="noreferrer" className="hover:text-neutral-200">Strike docs</a>
              </span>
            </footer>
          </WalletProvider>
        </LiveProvider>
      )}
    </main>
  );
}
