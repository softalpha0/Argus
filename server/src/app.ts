import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { FastifyRequest } from 'fastify';
import type { Exchange } from './exchange/Exchange.js';
import type { ExecutionManager } from './engine/ExecutionManager.js';
import type { Store } from './store/Store.js';
import { registerRoutes } from './api/routes.js';
import { marketView, registerLive } from './api/live.js';
import type { Accounts } from './users/Accounts.js';
import { registerConnect } from './api/connect.js';
import { registerFunds } from './api/funds.js';
import { registerKeys } from './api/keys.js';
import { makeAuth } from './api/auth.js';
import type { ApiKeys } from './users/ApiKeys.js';
import { registerV1 } from './api/v1.js';
import { registerMcpHttp } from './api/mcpHttp.js';
import { registerWebhooks } from './api/webhooks.js';
import type { Webhooks } from './webhooks/Webhooks.js';
import { buildReceipt, executionView, type ExecutionSnapshot } from './api/receipt.js';
import type { Execution } from './engine/Execution.js';
import type { Idempotency } from './api/idempotency.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (built).
const webDist = path.resolve(here, '../../web/dist');

export interface AppDeps {
  logger?: boolean;
  exchange?: Exchange;
  manager?: ExecutionManager;
  store?: Store;
  accounts?: Accounts;
  apiKeys?: ApiKeys;
  idempotency?: Idempotency;
  /** v1 event stream refresh; tests shorten it. */
  streamTickMs?: number;
  /** MCP execute polling interval; tests shorten it. */
  mcpPollMs?: number;
  webhooks?: Webhooks;
}

export async function buildApp(config: Config, opts: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Render and most hosts terminate TLS at a proxy; trust it so req.protocol is right.
    trustProxy: true,
    logger: opts.logger === false ? false : {
      level: config.production ? 'info' : 'debug',
      // Never log credentials.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-api-wallet-signature"]', 'req.headers["x-api-wallet-public-key"]'],
    },
  });

  if (!config.production) {
    await app.register(cors, { origin: true, credentials: true });
  }
  await app.register(cookie);
  await app.register(websocket);

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/config', async () => ({
    env: config.env,
    symbol: config.symbol,
    argusFeeBps: config.argusFeeBps,
    takerFee: config.takerFee,
    makerFee: config.makerFee,
    liveConfigured: config.liveConfigured,
    liveNotConfiguredReason: config.liveNotConfiguredReason,
  }));

  if (opts.exchange && opts.manager && opts.store) {
    const auth = makeAuth(opts.accounts ?? null, opts.apiKeys ?? null, config.env);
    if (opts.accounts) {
      registerConnect(app, config, opts.accounts);
      // Deposits and withdrawals stay browser-session only.
      registerFunds(app, opts.accounts, auth.sessionOwner, config.symbol);
    }
    if (opts.apiKeys) registerKeys(app, opts.apiKeys, opts.manager, auth.sessionOwner);
    const market = opts.exchange.market;
    app.get('/api/market', async () => ({ ...marketView(market, config.symbol), ...market.health() }));
    registerRoutes(app, { config, manager: opts.manager, store: opts.store, ownerOf: auth.ownerOf, callerOf: auth.caller });
    registerLive(app, market, opts.manager, config.symbol, auth.ownerOf);
    if (opts.idempotency) {
      registerV1(app, {
        manager: opts.manager,
        venue: { exchange: opts.exchange.id, network: config.env, symbol: config.symbol },
        callerOf: auth.caller,
        idempotency: opts.idempotency,
        streamTickMs: opts.streamTickMs,
      });
      registerMcpHttp(app, auth.caller, { pollMs: opts.mcpPollMs });
    }
    if (opts.webhooks) {
      const webhooks = opts.webhooks;
      const manager = opts.manager;
      const venue = { exchange: opts.exchange.id, network: config.env, symbol: config.symbol };
      registerWebhooks(app, webhooks, auth.sessionOwner);
      // Owners get "execution.finished" with the same view and receipt the v1 API returns.
      const onDone = (e: Execution) => {
        if (!e.owner) return;
        const j = e.toJSON() as unknown as ExecutionSnapshot;
        const meta = manager.metaOf(e.id);
        webhooks.emit(e.owner, 'execution.finished', { execution: executionView(j, venue, meta), receipt: buildReceipt(j, venue, meta) });
      };
      manager.on('done', onDone);
      app.addHook('onClose', async () => {
        manager.off('done', onDone);
      });
    }
  }

  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist });
    // SPA fallback for client-side routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/v1') && !req.url.startsWith('/mcp') && !req.url.startsWith('/live')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
