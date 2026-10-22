export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface Me {
  address: string;
  chain: 'solana' | 'cardano';
  network: 'mainnet' | 'testnet';
  accountId: string;
  apiWalletPublicKey: string;
  feeShareBps: number;
  connectedAt: number;
  keyExpiresAt: number | null;
  balances: { asset: string; walletBalance: string; availableBalance: string }[] | null;
  balanceError: string | null;
}
