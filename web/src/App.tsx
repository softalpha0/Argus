import { useEffect, useState } from 'react';
import { WalletProvider, shortAddress, useWallet } from './lib/wallet';
import { LiveProvider, useLive } from './lib/live';
import { useRoute } from './lib/router';
import Trade from './pages/Trade';
import Execution from './pages/Execution';
import Report from './pages/Report';
import Stats from './pages/Stats';

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
  const { me } = useWallet();
  const route = useRoute();
  const link = (href: string, label: string, on: boolean) => (
    <a href={href} className={`rounded-md px-3 py-1.5 text-sm ${on ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100'}`}>{label}</a>
  );
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-4">
      <a href="#/" className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tracking-tight">Argus</span>
        <span className="hidden text-sm text-neutral-500 sm:inline">Get paid to trade on Strike.</span>
      </a>
      <nav className="flex items-center gap-1">
        {link('#/', 'Trade', route.page === 'trade')}
        {link('#/stats', 'Stats', route.page === 'stats')}
      </nav>
      <div className="flex items-center gap-3 font-mono text-xs text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${connected && market?.live ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          {env} {market?.live ? 'L3 live' : 'syncing'}
        </span>
        {me && <span className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-200">{shortAddress(me.address)}</span>}
      </div>
    </header>
  );
}

function Body({ config }: { config: ServerConfig }) {
  const route = useRoute();
  if (route.page === 'execution') return <Execution id={route.id} />;
  if (route.page === 'report') return <Report id={route.id} />;
  if (route.page === 'stats') return <Stats />;
  return <Trade config={config} />;
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
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6">
      {error && <p className="text-red-400">Server not reachable: {error}</p>}
      {!error && !config && <p className="text-neutral-500">Connecting…</p>}
      {config && (
        <LiveProvider>
          <WalletProvider>
            <Header env={config.env} />
            <Body config={config} />
          </WalletProvider>
        </LiveProvider>
      )}
    </main>
  );
}
