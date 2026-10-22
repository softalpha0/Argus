import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Decimal } from 'decimal.js';
import { StrikeError } from '../strike/rest.js';
import { Accounts, ConnectError } from '../users/Accounts.js';

/** Decimals of each depositable asset's smallest unit, per chain. */
const ASSETS: Record<'solana' | 'cardano', Record<string, number>> = {
  solana: { USDC: 6, SOL: 9 },
  cardano: { ADA: 6 },
};

export const MIN_DEPOSIT_USD = 5;

export function toSmallestUnit(amount: unknown, decimals: number): string {
  let d: Decimal;
  try {
    d = new Decimal(String(amount));
  } catch {
    throw new ConnectError('Amount must be a number');
  }
  if (!d.isFinite() || d.lte(0)) throw new ConnectError('Amount must be greater than 0');
  const units = d.mul(new Decimal(10).pow(decimals));
  if (!units.isInteger()) throw new ConnectError(`Amount has more than ${decimals} decimal places`);
  return units.toFixed(0);
}

/**
 * Deposits and withdrawals through Strike's Builder API, signed with the user's
 * trade-only API wallet. Strike fixes the deposit address and the withdrawal
 * recipient (the user's own wallet), and every step still needs the user's
 * wallet signature in the browser.
 */
export function registerFunds(app: FastifyInstance, accounts: Accounts, ownerOf: (req: FastifyRequest) => string | null, symbol = 'BTC-USD'): void {
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ConnectError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof StrikeError) return reply.code(err.status >= 500 || err.status === 0 ? 502 : 400).send({ error: `Strike: ${err.message}` });
    throw err;
  };
  const user = (req: FastifyRequest) => {
    const owner = ownerOf(req);
    if (!owner) throw new ConnectError('Connect your wallet first', 401);
    const u = accounts.user(owner);
    if (!u) throw new ConnectError('Connect your wallet first', 401);
    return { owner, chain: u.chain ?? 'solana', rest: accounts.restFor(owner) } as const;
  };

  // One of the user's own orders, exactly as Strike returns it (evidence for reports).
  app.get<{ Params: { clientOrderId: string } }>('/api/orders/:clientOrderId', async (req, reply) => {
    try {
      const { rest } = user(req);
      if (!/^argus-[A-Za-z0-9-]+$/.test(req.params.clientOrderId)) throw new ConnectError('Not an Argus order ID');
      return await rest.getOrderByClientId(symbol, req.params.clientOrderId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/funds/options', async (req, reply) => {
    try {
      const { chain } = user(req);
      return { chain, assets: Object.keys(ASSETS[chain]), minDepositUsd: MIN_DEPOSIT_USD };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/funds/deposit/quote', async (req, reply) => {
    try {
      const { chain, rest } = user(req);
      const b = (req.body ?? {}) as { asset?: unknown; amount?: unknown };
      const asset = String(b.asset ?? '').toUpperCase();
      const decimals = ASSETS[chain][asset];
      if (decimals === undefined) throw new ConnectError(`You can deposit ${Object.keys(ASSETS[chain]).join(' or ')} from a ${chain} wallet`);
      const q = await rest.depositQuote({ blockchain: chain, asset_symbol: asset, asset_amount: toSmallestUnit(b.amount, decimals) });
      const usd = Number((q.quote as { usd_value?: string }).usd_value ?? 0);
      if (usd && usd < MIN_DEPOSIT_USD) throw new ConnectError(`Strike's minimum deposit is $${MIN_DEPOSIT_USD}; this is about $${usd.toFixed(2)}`);
      return q;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/funds/deposit/build', async (req, reply) => {
    try {
      const { owner, chain, rest } = user(req);
      const b = (req.body ?? {}) as { requestId?: unknown; utxos?: unknown };
      if (typeof b.requestId !== 'string') throw new ConnectError('Missing requestId');
      const utxos = Array.isArray(b.utxos) ? b.utxos.filter((u): u is string => typeof u === 'string') : undefined;
      if (chain === 'cardano' && !utxos?.length) throw new ConnectError('Your Cardano wallet has no spendable coins to deposit from');
      return await rest.depositBuildTx({ request_id: b.requestId, user_address: owner, utxos });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/funds/deposit/confirm', async (req, reply) => {
    try {
      const { rest } = user(req);
      const b = (req.body ?? {}) as { requestId?: unknown; txHash?: unknown };
      if (typeof b.requestId !== 'string' || typeof b.txHash !== 'string') throw new ConnectError('Missing requestId or txHash');
      return await rest.depositConfirm({ request_id: b.requestId, tx_hash: b.txHash });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/funds/withdraw/quote', async (req, reply) => {
    try {
      const { chain, rest } = user(req);
      const b = (req.body ?? {}) as { usd?: unknown; asset?: unknown };
      let usd: Decimal;
      try {
        usd = new Decimal(String(b.usd));
      } catch {
        throw new ConnectError('Amount must be a number');
      }
      if (!usd.isFinite() || usd.lte(0)) throw new ConnectError('Amount must be greater than 0');
      const asset = typeof b.asset === 'string' && b.asset ? b.asset.toUpperCase() : undefined;
      return await rest.withdrawQuote({ blockchain: chain, usd_value: usd.toFixed(2), asset });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/funds/withdraw/confirm', async (req, reply) => {
    try {
      const { rest } = user(req);
      const b = (req.body ?? {}) as { withdrawId?: unknown; signature?: unknown; signedTxCbor?: unknown };
      if (typeof b.withdrawId !== 'string' || typeof b.signature !== 'string') throw new ConnectError('Missing withdrawId or signature');
      return await rest.withdrawConfirm({
        withdraw_id: b.withdrawId,
        wallet_signature: b.signature,
        signed_tx_cbor: typeof b.signedTxCbor === 'string' ? b.signedTxCbor : undefined,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
