import Modal from './Modal';
import { useWallet } from '../lib/wallet';

export default function WalletModal({ network, onClose }: { network: string; onClose: () => void }) {
  const { connect, busy, error, cardanoWallets, hasPhantom } = useWallet();
  const option = (key: string, label: string, sub: string, icon: string | null, onClick: () => void) => (
    <button key={key} onClick={onClick} disabled={busy} className="flex w-full items-center gap-3 rounded-lg border border-neutral-800 px-4 py-3 text-left hover:border-neutral-600 hover:bg-neutral-900 disabled:opacity-50">
      {icon ? <img src={icon} alt="" className="h-7 w-7 rounded" /> : <span className="grid h-7 w-7 place-items-center rounded bg-violet-500/20 text-sm text-violet-300">◎</span>}
      <span className="grid">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-neutral-400">{sub}</span>
      </span>
    </button>
  );
  return (
    <Modal title="Connect a wallet" onClose={onClose}>
      <p className="text-sm text-neutral-400">
        Sign one message. Argus gets a trading-only key through Strike's Builder Connect. It can place and cancel orders but can never withdraw. Withdrawals always need your own wallet's signature and go only to your wallet.
      </p>
      <div className="grid gap-2">
        {option('phantom', 'Phantom', hasPhantom ? 'Solana' : 'Solana · not installed, opens phantom.app', null, () => void connect('phantom').then(onClose).catch(() => undefined))}
        {cardanoWallets.map((w) =>
          option(w.id, w.name.replace(/^./, (c) => c.toUpperCase()), `Cardano · use ${network === 'mainnet' ? 'Mainnet' : 'Preprod'}`, w.icon || null, () => void connect(w.id).then(onClose).catch(() => undefined)),
        )}
        {cardanoWallets.length === 0 && <p className="text-xs text-neutral-500">Cardano wallets such as Lace or Eternl appear here once installed.</p>}
      </div>
      {busy && <p className="text-sm text-neutral-300">Check your wallet to approve the signature…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <p className="text-xs text-neutral-500">Network: {network}. Mainnet and testnet are separate Strike accounts.</p>
    </Modal>
  );
}
