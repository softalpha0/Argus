/** Base-tier (tier 0) trading fees from GET /v2/fee-tiers; these are what a new account pays. */
export interface BaseFees {
  takerFee: string;
  makerFee: string;
}

export function parseBaseFees(body: unknown): BaseFees {
  const tiers = (body as { feeTiers?: { Tier: number; TakerRate: number; MakerRate: number }[] })?.feeTiers;
  if (!Array.isArray(tiers)) throw new Error('fee-tiers: no feeTiers array');
  const base = tiers.find((t) => t.Tier === 0);
  if (!base || !Number.isFinite(base.TakerRate) || !Number.isFinite(base.MakerRate)) throw new Error('fee-tiers: no valid tier 0');
  // Rates arrive as JSON numbers; print them as plain decimals (5e-5 → "0.00005").
  const str = (n: number) => (n === 0 ? '0' : n.toFixed(10).replace(/0+$/, '').replace(/\.$/, ''));
  return { takerFee: str(base.TakerRate), makerFee: str(base.MakerRate) };
}

export async function fetchBaseFees(restHost: string, timeoutMs = 5000): Promise<BaseFees> {
  const res = await fetch(`${restHost}/v2/fee-tiers`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`fee-tiers: HTTP ${res.status}`);
  return parseBaseFees(await res.json());
}
