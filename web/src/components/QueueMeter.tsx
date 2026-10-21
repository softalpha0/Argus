import { duration } from '../lib/format';

interface Props {
  place: number | null;
  sizeAhead: string;
  estimating: boolean;
  etaSec: number | null;
}

export default function QueueMeter({ place, sizeAhead, estimating, etaSec }: Props) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-sm tabular-nums">
      <span className="text-lg font-semibold text-amber-300">{place ? `#${place} in line` : estimating ? 'estimating place' : 'in line'}</span>
      <span className="text-neutral-400">·</span>
      <span>{Number(sizeAhead).toFixed(5)} BTC ahead</span>
      <span className="text-neutral-400">·</span>
      <span className="text-neutral-300">{etaSec === null ? 'no recent fills to estimate' : `~${duration(etaSec)}`}</span>
    </div>
  );
}
