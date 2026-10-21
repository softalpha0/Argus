import type { BookLevel } from '../lib/types';
import { num } from '../lib/format';

interface Props {
  bids: BookLevel[];
  asks: BookLevel[];
  rows?: number;
  /** Highlight our resting order. */
  ours?: { side: 'buy' | 'sell'; price: string; publicLinked?: boolean; place?: number | null; size?: string } | null;
}

/** L3 ladder: each price level shows its orders in queue order as segments. */
export default function Ladder({ bids, asks, rows = 8, ours }: Props) {
  const a = asks.slice(0, rows).reverse();
  const b = bids.slice(0, rows);
  const max = Math.max(...[...a, ...b].map((l) => Number(l.total)), 0.000001);
  const Row = ({ l, side }: { l: BookLevel; side: 'buy' | 'sell' }) => {
    const isOurs = ours && ours.side === side && Number(ours.price) === Number(l.price);
    const width = (Number(l.total) / max) * 100;
    return (
      <div className={`grid grid-cols-[5.5rem_1fr_5.5rem] items-center gap-2 px-2 py-[3px] text-xs ${isOurs ? 'bg-amber-400/10 ring-1 ring-amber-400/50' : ''}`}>
        <span className={`font-mono tabular-nums ${side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{num(l.price, 0)}</span>
        <div className="flex h-3 min-w-0 overflow-hidden rounded-sm" style={{ width: `${Math.max(width, 2)}%` }} title={`${l.orders.length} orders`}>
          {l.orders.slice(0, 40).map((o, i) => (
            <span
              key={o.id}
              className={`h-full border-r border-neutral-950 ${side === 'buy' ? 'bg-emerald-500/50' : 'bg-rose-500/50'} ${i === 0 ? 'opacity-100' : 'opacity-70'}`}
              style={{ flexGrow: Number(o.size) }}
            />
          ))}
        </div>
        <span className="text-right font-mono tabular-nums text-neutral-400">{Number(l.total).toFixed(5)}</span>
      </div>
    );
  };
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 py-1">
      <div className="grid grid-cols-[5.5rem_1fr_5.5rem] gap-2 px-2 pb-1 text-[11px] uppercase tracking-wider text-neutral-500">
        <span>Price</span>
        <span>Orders in line</span>
        <span className="text-right">BTC</span>
      </div>
      {a.map((l) => <Row key={`a${l.price}`} l={l} side="sell" />)}
      <div className="my-1 border-t border-dashed border-neutral-700" />
      {b.map((l) => <Row key={`b${l.price}`} l={l} side="buy" />)}
      {ours && <p className="px-2 pt-1 text-[11px] text-amber-300/80">Highlighted: the level where your order rests{ours.publicLinked === false ? ' (paper orders are not in the real book)' : ''}.</p>}
    </div>
  );
}
