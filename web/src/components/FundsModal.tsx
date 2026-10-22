import { useEffect, useState } from 'react';
import bs58 from 'bs58';
import Modal from './Modal';
import { api } from '../lib/api';
import { useWallet, getPhantom } from '../lib/wallet';
import { connectCardano, rememberedCardanoWallet, listCardanoWallets, type CardanoSession } from '../lib/cardano';
import { assembleSignedTx, hexToBytes } from '../lib/cbor';
import { usd } from '../lib/format';

interface Props {
  tab: 'deposit' | 'withdraw';
  network: string;
  onClose: () => void;
}

interface DepositQuote { request_id: string; quote: { usd_value?: string; exchange_rate?: string; asset_amount?: string }; confirmations_required: number }
interface WithdrawQuote { withdraw_id: string; fee: string; message_to_sign: string; tx_cbor?: string }

const explorer = (network: string, chain: string, tx: string) =>
  chain === 'cardano' ? `https://${network === 'mainnet' ? '' : 'preprod.'}cardanoscan.io/transaction/${tx}` : `https://solscan.io/tx/${tx}`;

/** Re-open the Cardano wallet that signed in, and make sure it is still the same address. */
async function cardanoFor(address: string): Promise<CardanoSession> {
  const ids = [rememberedCardanoWallet(), ...listCardanoWallets().map((w) => w.id)].filter((x): x is string => !!x);
  for (const id of [...new Set(ids)]) {
    try {
      const s = await connectCardano(id);
      if (s.address === address) return s;
    } catch {
      /* try the next wallet */
    }
  }
  throw new Error('Open the Cardano wallet you connected with (same address) and try again.');
}

export default function FundsModal({ tab: initial, network, onClose }: Props) {
  const { me, refresh } = useWallet();
  const [tab, setTab] = useState(initial);
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState('');
  const [assets, setAssets] = useState<string[]>([]);
  const [dq, setDq] = useState<DepositQuote | null>(null);
  const [wq, setWq] = useState<WithdrawQuote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; tx?: string } | null>(null);

  useEffect(() => {
    api<{ assets: string[] }>('/api/funds/options').then((o) => {
      setAssets(o.assets);
      setAsset(o.assets[0] ?? '');
    }).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    setDq(null);
    setWq(null);
    setError(null);
    setDone(null);
    setAmount('');
  }, [tab]);

  if (!me) return null;
  const chain = me.chain;
  const available = Number(me.balances?.find((b) => /USD/.test(b.asset))?.availableBalance ?? 0);
  const strikeApp = network === 'mainnet' ? 'https://app.strikefinance.org' : 'https://testnet.strikefinance.org';

  const run = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      const err = e as { message?: string; info?: string };
      const msg = err.message ?? err.info ?? String(e);
      setError(/reject|declin|cancel|denied/i.test(msg) ? 'You cancelled in your wallet.' : msg);
    } finally {
      setBusy(null);
    }
  };

  const quoteDeposit = () =>
    run('Getting a quote…', async () => {
      setDq(await api<DepositQuote>('/api/funds/deposit/quote', { method: 'POST', json: { asset, amount } }));
    });

  const sendDeposit = () =>
    run('Waiting for your wallet…', async () => {
      if (!dq) return;
      const w = await cardanoFor(me.address);
      const utxos = await w.utxos();
      setBusy('Building the transaction…');
      const built = await api<{ unsigned_tx: string; format: string }>('/api/funds/deposit/build', { method: 'POST', json: { requestId: dq.request_id, utxos } });
      if (built.format !== 'cardano_cbor' || typeof built.unsigned_tx !== 'string') throw new Error(`Unexpected transaction format: ${built.format}`);
      setBusy('Approve the deposit in your wallet…');
      const witness = await w.signTx(built.unsigned_tx);
      const signed = assembleSignedTx(built.unsigned_tx, witness);
      setBusy('Submitting…');
      const txHash = await w.submitTx(signed);
      await api('/api/funds/deposit/confirm', { method: 'POST', json: { requestId: dq.request_id, txHash } });
      setDone({ text: `Deposit sent. It is credited after ${dq.confirmations_required} confirmations, usually a few minutes.`, tx: txHash });
      setDq(null);
      window.setTimeout(() => void refresh(), 60_000);
    });

  const quoteWithdraw = () =>
    run('Getting a quote…', async () => {
      setWq(await api<WithdrawQuote>('/api/funds/withdraw/quote', { method: 'POST', json: { usd: amount, asset: asset || undefined } }));
    });

  const sendWithdraw = () =>
    run('Sign in your wallet…', async () => {
      if (!wq) return;
      let signature: string;
      let signedTxCbor: string | undefined;
      if (chain === 'cardano') {
        const w = await cardanoFor(me.address);
        signature = await w.signHex(wq.message_to_sign);
        if (wq.tx_cbor) {
          setBusy('Approve the withdrawal transaction…');
          signedTxCbor = assembleSignedTx(wq.tx_cbor, await w.signTx(wq.tx_cbor));
        }
      } else {
        const phantom = getPhantom();
        if (!phantom) throw new Error('Phantom is not available in this browser.');
        await phantom.connect();
        const { signature: sig } = await phantom.signMessage(new TextEncoder().encode(wq.message_to_sign), 'utf8');
        signature = bs58.encode(sig);
      }
      setBusy('Submitting…');
      const r = await api<{ status: string }>('/api/funds/withdraw/confirm', { method: 'POST', json: { withdrawId: wq.withdraw_id, signature, signedTxCbor } });
      setDone({ text: `Withdrawal ${r.status}. Funds go to your connected wallet (${me.address.slice(0, 12)}…).` });
      setWq(null);
      window.setTimeout(() => void refresh(), 15_000);
    });

  const seg = (on: boolean) => `flex-1 rounded-md px-3 py-2 text-sm font-medium ${on ? 'bg-neutral-100 text-neutral-950' : 'text-neutral-400 hover:text-neutral-200'}`;
  const decodedMessage = (() => {
    if (!wq || chain !== 'cardano') return wq?.message_to_sign;
    try {
      return new TextDecoder().decode(hexToBytes(wq.message_to_sign));
    } catch {
      return wq.message_to_sign;
    }
  })();

  return (
    <Modal title="Funds" onClose={onClose}>
      <div className="flex gap-1 rounded-lg bg-ink-800 p-1">
        <button className={seg(tab === 'deposit')} onClick={() => setTab('deposit')}>Deposit</button>
        <button className={seg(tab === 'withdraw')} onClick={() => setTab('withdraw')}>Withdraw</button>
      </div>
      <p className="font-mono text-sm text-neutral-300">Available on Strike: {usd(available, 2)}</p>

      {tab === 'deposit' && chain === 'solana' && (
        <p className="text-sm text-neutral-400">
          Deposits from Phantom go through Strike's app for now. Open <a className="text-emerald-400 underline" href={strikeApp} target="_blank" rel="noreferrer">{strikeApp.replace('https://', '')}</a> with the same wallet and click Deposit. The balance shows up here after.
        </p>
      )}

      {tab === 'deposit' && chain === 'cardano' && (
        <div className="grid gap-3">
          <label className="grid gap-1" htmlFor="dep-amt">
            <span className="text-xs uppercase tracking-wider text-neutral-500">Amount ({asset || 'ADA'})</span>
            <input id="dep-amt" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.trim()); setDq(null); }} className="rounded-md border border-ink-600 bg-ink-800 px-3 py-2 font-mono" placeholder="1000" />
            <span className="text-xs text-neutral-500">Strike's minimum deposit is $5. Keep a few ADA in your wallet for the network fee.</span>
          </label>
          {!dq ? (
            <button onClick={quoteDeposit} disabled={!!busy || !amount} className="rounded-md bg-neutral-100 px-4 py-2 font-medium text-neutral-950 disabled:opacity-40">Get quote</button>
          ) : (
            <div className="grid gap-2 rounded-md bg-ink-800 p-3 text-sm">
              <div className="flex justify-between"><span className="text-neutral-400">You deposit</span><span className="font-mono">{amount} {asset}</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">Credited</span><span className="font-mono">{usd(dq.quote.usd_value, 2)}</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">Rate</span><span className="font-mono">{dq.quote.exchange_rate ?? '—'}</span></div>
              <p className="text-xs text-neutral-500">Strike builds the transaction and fixes the destination. Your wallet shows the exact amount and address before you approve.</p>
              <button onClick={sendDeposit} disabled={!!busy} className="rounded-md bg-maker px-4 py-2 font-medium text-neutral-950 disabled:opacity-40">Deposit</button>
            </div>
          )}
        </div>
      )}

      {tab === 'withdraw' && (
        <div className="grid gap-3">
          <label className="grid gap-1" htmlFor="wd-amt">
            <span className="text-xs uppercase tracking-wider text-neutral-500">Amount (USD)</span>
            <div className="flex gap-2">
              <input id="wd-amt" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.trim()); setWq(null); }} className="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 font-mono" placeholder="10" />
              <button onClick={() => setAmount(Math.floor(available * 100) / 100 + '')} className="rounded-md border border-ink-600 px-3 text-sm hover:bg-ink-800">Max</button>
            </div>
          </label>
          {assets.length > 1 && (
            <label className="grid gap-1" htmlFor="wd-asset">
              <span className="text-xs uppercase tracking-wider text-neutral-500">Receive as</span>
              <select id="wd-asset" value={asset} onChange={(e) => setAsset(e.target.value)} className="rounded-md border border-ink-600 bg-ink-800 px-3 py-2">
                {assets.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          )}
          {!wq ? (
            <button onClick={quoteWithdraw} disabled={!!busy || !amount} className="rounded-md bg-neutral-100 px-4 py-2 font-medium text-neutral-950 disabled:opacity-40">Get quote</button>
          ) : (
            <div className="grid gap-2 rounded-md bg-ink-800 p-3 text-sm">
              <div className="flex justify-between"><span className="text-neutral-400">Withdraw</span><span className="font-mono">{usd(amount, 2)}</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">Fee</span><span className="font-mono">{usd(wq.fee, 2)}</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">To</span><span className="truncate font-mono">{me.address.slice(0, 16)}…</span></div>
              {decodedMessage && <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-xs text-neutral-400">{decodedMessage}</pre>}
              <button onClick={sendWithdraw} disabled={!!busy} className="rounded-md bg-maker px-4 py-2 font-medium text-neutral-950 disabled:opacity-40">Sign and withdraw</button>
            </div>
          )}
          <p className="text-xs text-neutral-500">Strike sends withdrawals only to the wallet you connected. Argus's key cannot withdraw on its own.</p>
        </div>
      )}

      {busy && <p className="text-sm text-neutral-300">{busy}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {done && (
        <p className="text-sm text-emerald-300">
          {done.text}{' '}
          {done.tx && <a className="underline" href={explorer(network, chain, done.tx)} target="_blank" rel="noreferrer">View transaction</a>}
        </p>
      )}
    </Modal>
  );
}
