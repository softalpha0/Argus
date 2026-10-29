import type { FastifyRequest } from 'fastify';
import type { Accounts } from '../users/Accounts.js';
import type { ApiKeyRecord, ApiKeys } from '../users/ApiKeys.js';
import { sessionCookie } from '../users/Sessions.js';

export interface Caller {
  /** Wallet address the request acts for. */
  owner: string;
  via: 'session' | 'apiKey';
  apiKey?: ApiKeyRecord;
}

export class AuthError extends Error {
  readonly status = 401;
}

/**
 * Resolves who a request is from: a browser session cookie, or an API key in
 * "Authorization: Bearer argus_…". A key that is present but wrong or revoked is
 * an error rather than an anonymous request, so a program never trades as nobody.
 */
export function makeAuth(accounts: Accounts | null, apiKeys: ApiKeys | null, env: 'mainnet' | 'testnet') {
  const cookieName = sessionCookie(env);

  const bearer = (req: FastifyRequest): string | null => {
    const h = req.headers.authorization;
    if (!h) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) throw new AuthError('Authorization header must be "Bearer <API key>"');
    return m[1]!;
  };

  const sessionOwner = (req: FastifyRequest): string | null => accounts?.sessions.get(req.cookies?.[cookieName])?.address ?? null;

  const caller = (req: FastifyRequest): Caller | null => {
    const token = bearer(req);
    if (token !== null) {
      const key = apiKeys?.verify(token);
      if (!key) throw new AuthError('Invalid or revoked API key');
      return { owner: key.owner, via: 'apiKey', apiKey: key };
    }
    const owner = sessionOwner(req);
    return owner ? { owner, via: 'session' } : null;
  };

  return {
    caller,
    /** Session or API key. */
    ownerOf: (req: FastifyRequest): string | null => caller(req)?.owner ?? null,
    /** Browser session only: funds and key management never accept an API key. */
    sessionOwner,
  };
}

export type Auth = ReturnType<typeof makeAuth>;
