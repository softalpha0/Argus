export const usd = (v: string | number | null | undefined, digits?: number) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  const d = digits ?? (Math.abs(n) < 1 && n !== 0 ? 4 : 2);
  return `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
export const num = (v: string | number, digits = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const btc = (v: string | number) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 })} BTC`;
export const pct = (v: string | number, digits = 0) => `${(Number(v) * 100).toFixed(digits)}%`;
export const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const duration = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s` : `${Math.round(sec)}s`);
