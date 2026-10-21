import { useEffect, useState } from 'react';
import { WalletProvider } from './lib/wallet';
import Connect from './pages/Connect';

interface ServerConfig {
  env: string;
  symbol: string;
  argusFeeBps: number;
  liveConfigured: boolean;
  liveNotConfiguredReason: string | null;
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
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Argus</h1>
      <p className="mt-1 text-neutral-400">Get paid to trade on Strike.</p>
      <section className="mt-6 rounded-lg border border-neutral-800 p-4 font-mono text-sm">
        {error && <p className="text-red-400">Server not reachable: {error}</p>}
        {!error && !config && <p className="text-neutral-500">Connecting…</p>}
        {config && (
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-neutral-500">Network</dt><dd>{config.env}</dd>
            <dt className="text-neutral-500">Market</dt><dd>{config.symbol}</dd>
            <dt className="text-neutral-500">Argus fee</dt><dd>{config.argusFeeBps} bps</dd>
            <dt className="text-neutral-500">Live mode</dt>
            <dd>{config.liveConfigured ? 'ready' : config.liveNotConfiguredReason}</dd>
          </dl>
        )}
      </section>
      {config && (
        <div className="mt-4">
          <WalletProvider>
            <Connect liveConfigured={config.liveConfigured} reason={config.liveNotConfiguredReason} />
          </WalletProvider>
        </div>
      )}
    </main>
  );
}
