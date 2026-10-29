import { Decimal } from 'decimal.js';
import type { MarketRules } from '../exchange/Exchange.js';

/** Strike's filters for one symbol, in the generic shape every exchange adapter uses. */
export type SymbolRules = MarketRules;

interface RawFilter {
  filterType: string;
  [k: string]: unknown;
}

export function parseSymbolRules(info: unknown, symbol: string): SymbolRules {
  const symbols = (info as { symbols?: { symbol: string; status: string; filters: RawFilter[] }[] })?.symbols;
  if (!Array.isArray(symbols)) throw new Error('exchangeInfo: no symbols array');
  const s = symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`exchangeInfo: symbol ${symbol} not listed`);
  const f = (type: string) => s.filters.find((x) => x.filterType === type);
  const num = (filter: RawFilter | undefined, k: string, fallback?: string): Decimal => {
    const v = filter?.[k];
    if (typeof v === 'string' && v !== '') return new Decimal(v);
    if (fallback !== undefined) return new Decimal(fallback);
    throw new Error(`exchangeInfo: ${symbol} missing ${k}`);
  };
  const price = f('PRICE_FILTER');
  const lot = f('LOT_SIZE');
  const mlot = f('MARKET_LOT_SIZE');
  const notional = f('MIN_NOTIONAL');
  const rules: SymbolRules = {
    symbol,
    status: s.status,
    tickSize: num(price, 'tickSize'),
    minPrice: num(price, 'minPrice', '0'),
    maxPrice: num(price, 'maxPrice', '0'),
    stepSize: num(lot, 'stepSize'),
    minQty: num(lot, 'minQty'),
    maxQty: num(lot, 'maxQty', '0'),
    marketMaxQty: num(mlot ?? lot, 'maxQty', '0'),
    minNotional: num(notional, 'notional', '0'),
  };
  if (!rules.tickSize.gt(0) || !rules.stepSize.gt(0)) throw new Error(`exchangeInfo: ${symbol} has zero tick or step`);
  return rules;
}

export async function fetchSymbolRules(marketRest: string, symbol: string, fetchFn: typeof fetch = fetch): Promise<SymbolRules> {
  const res = await fetchFn(`${marketRest}/v2/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
  return parseSymbolRules(await res.json(), symbol);
}

/** Round a price to the tick grid. Buys round down and sells round up, so rounding never worsens the user's limit. */
export function roundPrice(rules: SymbolRules, price: Decimal.Value, mode: 'down' | 'up'): Decimal {
  const p = new Decimal(price);
  const ticks = p.div(rules.tickSize);
  const n = mode === 'down' ? ticks.floor() : ticks.ceil();
  return n.mul(rules.tickSize);
}

export function roundSize(rules: SymbolRules, size: Decimal.Value): Decimal {
  return new Decimal(size).div(rules.stepSize).floor().mul(rules.stepSize);
}

/** Returns a human-readable reason the order is invalid, or null if it passes. */
export function checkOrder(rules: SymbolRules, size: Decimal.Value, price: Decimal.Value, kind: 'limit' | 'market' = 'limit'): string | null {
  const s = new Decimal(size);
  const p = new Decimal(price);
  if (!s.eq(roundSize(rules, s))) return `Size must be a multiple of ${rules.stepSize} BTC`;
  if (s.lt(rules.minQty)) return `Size is below the minimum of ${rules.minQty} BTC`;
  const max = kind === 'market' ? rules.marketMaxQty : rules.maxQty;
  if (max.gt(0) && s.gt(max)) return `Size is above the maximum of ${max} BTC`;
  const notional = s.mul(p);
  if (notional.lt(rules.minNotional)) {
    return `Order value $${notional.toFixed(2)} is below Strike's minimum of $${rules.minNotional}`;
  }
  if (kind === 'limit') {
    if (!p.eq(roundPrice(rules, p, 'down'))) return `Price must be a multiple of ${rules.tickSize}`;
    if (rules.minPrice.gt(0) && p.lt(rules.minPrice)) return `Price is below ${rules.minPrice}`;
    if (rules.maxPrice.gt(0) && p.gt(rules.maxPrice)) return `Price is above ${rules.maxPrice}`;
  }
  return null;
}
