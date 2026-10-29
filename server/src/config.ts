import path from 'node:path';

export type StrikeEnv = 'mainnet' | 'testnet';

export interface StrikeHosts {
  rest: string;
  marketRest: string;
  l3Ws: string;
  priceWs: string;
  userWs: string;
}

export const HOSTS: Record<StrikeEnv, StrikeHosts> = {
  mainnet: {
    rest: 'https://api.strikefinance.org',
    marketRest: 'https://api.strikefinance.org/price',
    l3Ws: 'wss://api.strikefinance.org/ws/l3',
    priceWs: 'wss://api.strikefinance.org/ws/price',
    // Note: the mainnet user websocket lives on a different host.
    userWs: 'wss://api-v2.strikefinance.org/ws/user-api',
  },
  testnet: {
    rest: 'https://api-v2-testnet.strikefinance.org',
    marketRest: 'https://api-v2-testnet.strikefinance.org/price',
    l3Ws: 'wss://api-v2-testnet.strikefinance.org/ws/l3',
    priceWs: 'wss://api-v2-testnet.strikefinance.org/ws/price',
    userWs: 'wss://api-v2-testnet.strikefinance.org/ws/user-api',
  },
};

export interface Config {
  env: StrikeEnv;
  hosts: StrikeHosts;
  symbol: string;
  port: number;
  dataDir: string;
  /** Postgres connection string; when unset, data is kept in files under dataDir. */
  databaseUrl: string | null;
  builderCode: string | null;
  builderMaxFeeBps: number;
  argusFeeBps: number;
  masterKey: string | null;
  takerFee: string;
  makerFee: string;
  /** True when TAKER_FEE or MAKER_FEE is set; otherwise the fees are read from Strike at startup. */
  feesPinned: boolean;
  production: boolean;
  /** Live mode needs a builder code and a master key. */
  liveConfigured: boolean;
  liveNotConfiguredReason: string | null;
}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

function decimalVar(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) throw new Error(`${name} must be a decimal number, got "${raw}"`);
  return raw.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const strikeEnv = (env.STRIKE_ENV ?? 'mainnet').trim() as StrikeEnv;
  if (strikeEnv !== 'mainnet' && strikeEnv !== 'testnet') {
    throw new Error(`STRIKE_ENV must be "mainnet" or "testnet", got "${strikeEnv}"`);
  }

  const builderCode = env.BUILDER_CODE?.trim() || null;
  let masterKey = env.ARGUS_MASTER_KEY?.trim() || null;
  if (masterKey && !/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new Error('ARGUS_MASTER_KEY must be 32 bytes as 64 hex characters');
  }
  if (masterKey) masterKey = masterKey.toLowerCase();

  const missing: string[] = [];
  if (!builderCode) missing.push('BUILDER_CODE');
  if (!masterKey) missing.push('ARGUS_MASTER_KEY');

  const builderMaxFeeBps = intVar(env, 'BUILDER_MAX_FEE_BPS', 10);
  const argusFeeBps = intVar(env, 'ARGUS_FEE_BPS', 2);
  if (argusFeeBps > builderMaxFeeBps) {
    throw new Error('ARGUS_FEE_BPS cannot be higher than BUILDER_MAX_FEE_BPS');
  }

  return {
    env: strikeEnv,
    hosts: HOSTS[strikeEnv],
    symbol: (env.SYMBOL ?? 'BTC-USD').trim(),
    port: intVar(env, 'PORT', 8080),
    dataDir: path.resolve(env.DATA_DIR?.trim() || './data'),
    databaseUrl: env.DATABASE_URL?.trim() || null,
    builderCode,
    builderMaxFeeBps,
    argusFeeBps,
    masterKey,
    takerFee: decimalVar(env, 'TAKER_FEE', '0.0005'),
    // Strike's base tier, until startup reads /v2/fee-tiers: testnet pays makers no rebate.
    makerFee: decimalVar(env, 'MAKER_FEE', strikeEnv === 'testnet' ? '0' : '-0.00005'),
    feesPinned: Boolean(env.TAKER_FEE?.trim() || env.MAKER_FEE?.trim()),
    production: env.NODE_ENV === 'production',
    liveConfigured: missing.length === 0,
    liveNotConfiguredReason: missing.length ? `Live mode is not configured: set ${missing.join(' and ')} in .env` : null,
  };
}
