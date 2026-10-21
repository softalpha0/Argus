import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { MarketFeeds } from './strike/feeds.js';
import pino from 'pino';
import { Store } from './store/Store.js';
import { ExecutionManager } from './engine/ExecutionManager.js';
import { Accounts } from './users/Accounts.js';

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.production ? 'info' : 'debug' });
  const feeds = new MarketFeeds(config, logger);
  const store = new Store(config.dataDir);
  const manager = new ExecutionManager(config, feeds, store, logger.child({ mod: 'exec' }));
  const accounts = new Accounts(config, logger.child({ mod: 'accounts' }));
  const app = await buildApp(config, { feeds, manager, store, accounts });

  if (!config.liveConfigured) app.log.warn(config.liveNotConfiguredReason);

  // Never crash on a stray async error; log it and keep serving.
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => app.log.error({ err }, 'uncaught exception'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  void feeds.start();
  shutdownHook = async () => {
    await manager.shutdown();
    feeds.stop();
    accounts.stop();
    await app.close();
  };
  app.log.info(`Argus on ${config.env} (${config.symbol}) at http://localhost:${config.port}`);
}

let shutdownHook: (() => Promise<void>) | null = null;
const shutdown = () => {
  // Cancel working orders before exiting; give up after 5 s.
  setTimeout(() => process.exit(0), 5000).unref();
  void (shutdownHook?.() ?? Promise.resolve()).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
