import type { ReportStep } from '../lib/types';

export default function SavingsBreakdown({ steps }: { steps: ReportStep[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-normal">Step</th>
            <th className="px-3 py-2 font-normal">How it's worked out</th>
            <th className="px-3 py-2 text-right font-normal">Value</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.n} className={`border-t border-neutral-800 ${s.n === 7 ? 'bg-emerald-500/5' : ''}`}>
              <td className="px-3 py-2 align-top">
                <span className="mr-2 font-mono text-neutral-500">{s.n}</span>
                {s.label}
              </td>
              <td className="px-3 py-2 align-top font-mono text-xs text-neutral-400">{s.formula}</td>
              <td className={`whitespace-nowrap px-3 py-2 text-right align-top font-mono tabular-nums ${s.n === 7 ? 'font-semibold' : ''}`}>{s.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
