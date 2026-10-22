import { shortAddress, useWallet } from '../lib/wallet';

export default function Connect({ liveConfigured, reason }: { liveConfigured: boolean; reason: string | null }) {
  const { me, loading, busy, error, connect, logout, refresh, cardanoWallets } = useWallet();

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
          Sign one message in your wallet. Argus gets a trading-only key through Strike's Builder Connect. It can place and cancel orders but can't withdraw.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => void connect('phantom')} disabled={busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">
            {busy ? 'Waiting for your wallet…' : 'Connect Phantom (Solana)'}
          </button>
          {cardanoWallets.map((w) => (
            <button key={w.id} onClick={() => void connect(w.id)} disabled={busy} className="flex items-center gap-2 rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium hover:bg-neutral-900 disabled:opacity-50">
              {w.icon && <img src={w.icon} alt="" className="h-4 w-4" />}
              Connect {w.name.replace(/^./, (c) => c.toUpperCase())} (Cardano)
            </button>
          ))}
        </div>
        {cardanoWallets.length === 0 && <p className="mt-2 text-xs text-neutral-500">Cardano wallets like Lace or Eternl show up here once installed.</p>}
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
        <dd className="truncate">{shortAddress(me.address)} · {me.chain === 'cardano' ? 'Cardano' : 'Solana'}</dd>
        <dt className="text-neutral-500">Network</dt>
        <dd>{me.network}</dd>
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
