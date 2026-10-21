import { shortAddress, useWallet } from '../lib/wallet';

export default function Connect({ liveConfigured, reason }: { liveConfigured: boolean; reason: string | null }) {
  const { me, loading, busy, error, connect, logout, refresh } = useWallet();

  if (!liveConfigured) {
    return (
      <section className="rounded-lg border border-neutral-800 p-4">
        <h2 className="font-medium">Live trading</h2>
        <p className="mt-1 text-sm text-neutral-400">{reason ?? 'Live mode is not configured on this server.'} Paper mode works without it.</p>
      </section>
    );
  }

  if (loading) return <section className="rounded-lg border border-neutral-800 p-4 text-sm text-neutral-500">Checking connection…</section>;

  if (!me) {
    return (
      <section className="rounded-lg border border-neutral-800 p-4">
        <h2 className="font-medium">Connect to trade live</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Sign one message in Phantom. Argus gets a trading-only key through Strike's Builder Connect. It can place and cancel orders but can't withdraw.
        </p>
        <button onClick={() => void connect()} disabled={busy} className="mt-3 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? 'Waiting for Phantom…' : 'Connect Phantom'}
        </button>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </section>
    );
  }

  const usd = me.balances?.find((b) => /USD/.test(b.asset));
  return (
    <section className="rounded-lg border border-neutral-800 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Connected</h2>
        <button onClick={() => void logout()} className="text-sm text-neutral-400 hover:text-neutral-200">
          Disconnect
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
        <dt className="text-neutral-500">Wallet</dt>
        <dd className="truncate">{shortAddress(me.address)}</dd>
        <dt className="text-neutral-500">Strike account</dt>
        <dd className="truncate">{me.accountId}</dd>
        <dt className="text-neutral-500">Max fee approved</dt>
        <dd>{me.feeShareBps} bps</dd>
        <dt className="text-neutral-500">Available</dt>
        <dd>{usd ? `$${Number(usd.availableBalance).toFixed(2)} ${usd.asset}` : me.balanceError ? <span className="text-amber-400">{me.balanceError}</span> : '—'}</dd>
      </dl>
      <button onClick={() => void refresh()} className="mt-2 text-sm text-neutral-400 hover:text-neutral-200">
        Refresh balance
      </button>
    </section>
  );
}
