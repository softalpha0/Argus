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
import type { MarketFeeds } from './strike/feeds.js';
import type { ExecutionManager } from './engine/ExecutionManager.js';
import type { Store } from './store/Store.js';
import { registerRoutes } from './api/routes.js';
import { marketView, registerLive } from './api/live.js';
import type { Accounts } from './users/Accounts.js';
import { registerConnect, sessionOwner } from './api/connect.js';
import { registerFunds } from './api/funds.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (built).
const webDist = path.resolve(here, '../../web/dist');

export async function buildApp(config: Config, opts: { logger?: boolean; feeds?: MarketFeeds; manager?: ExecutionManager; store?: Store; accounts?: Accounts } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.production ? 'info' : 'debug',
      // Never log credentials.
      redact: ['req.headers.cookie', 'req.headers["x-api-wallet-signature"]', 'req.headers["x-api-wallet-public-key"]'],
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

  if (opts.feeds && opts.manager && opts.store) {
    const ownerOf: (req: FastifyRequest) => string | null = opts.accounts ? sessionOwner(opts.accounts, config.env) : () => null;
    if (opts.accounts) {
      registerConnect(app, config, opts.accounts);
      registerFunds(app, opts.accounts, ownerOf);
    }
    const feeds = opts.feeds;
    app.get('/api/market', async () => ({ ...marketView(feeds, config.symbol), sync: { ...feeds.l3.stats }, tape: { connected: feeds.tape.connected, trades: feeds.tape.tradesSeen } }));
    registerRoutes(app, { config, feeds, manager: opts.manager, store: opts.store, ownerOf });
    registerLive(app, feeds, opts.manager, config.symbol, ownerOf);
  }

  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist });
    // SPA fallback for client-side routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/live')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
