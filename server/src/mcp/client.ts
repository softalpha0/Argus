import { randomUUID } from 'node:crypto';

export class ArgusApiError extends Error {
  constructor(readonly status: number, readonly type: string, message: string) {
    super(message);
  }
}

export interface MarketLevel {
  price: string;
  total: string;
}

export interface MarketSnapshot {
  symbol: string;
  live: boolean;
  mid: string | null;
  spread: string | null;
  rules: { tickSize: string; stepSize: string; minQty: string; minNotional: string } | null;
  book: { bids: MarketLevel[]; asks: MarketLevel[] } | null;
}

export interface ServerConfig {
  env: string;
  symbol: string;
  argusFeeBps: number;
  takerFee: string;
  makerFee: string;
  liveConfigured: boolean;
}

/** A thin client for the Argus v1 API, authenticated with an API key. */
export class ArgusClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly apiKey: string, private readonly fetchFn: typeof fetch = fetch) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchFn(this.base + path, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const e = (json as { error?: { type?: string; message?: string } | string } | undefined)?.error;
      const type = typeof e === 'object' && e?.type ? e.type : `http_${res.status}`;
      const message = typeof e === 'object' && e?.message ? e.message : typeof e === 'string' ? e : `Argus returned HTTP ${res.status}`;
      throw new ArgusApiError(res.status, type, message);
    }
    return json as T;
  }

  market = () => this.call<MarketSnapshot>('GET', '/api/market');
  config = () => this.call<ServerConfig>('GET', '/api/config');
  execute = (body: Record<string, unknown>, idempotencyKey: string = randomUUID()) =>
    this.call<Record<string, unknown>>('POST', '/v1/executions', body, { 'idempotency-key': idempotencyKey });
  get = (id: string) => this.call<Record<string, unknown>>('GET', `/v1/executions/${encodeURIComponent(id)}`);
  list = (limit = 10) => this.call<{ data: Record<string, unknown>[] }>('GET', `/v1/executions?limit=${limit}`);
  cancel = (id: string) => this.call<Record<string, unknown>>('POST', `/v1/executions/${encodeURIComponent(id)}/cancel`);
  receipt = (id: string) => this.call<Record<string, unknown>>('GET', `/v1/executions/${encodeURIComponent(id)}/receipt`);
}
