import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import pino from 'pino';
import { Store } from './store/Store.js';
import { ExecutionManager } from './engine/ExecutionManager.js';
import { Accounts } from './users/Accounts.js';
import { StrikeExchange } from './strike/StrikeExchange.js';
import { ApiKeys } from './users/ApiKeys.js';
import { openDocStore, scoped } from './db/DocStore.js';
import { Idempotency } from './api/idempotency.js';

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.production ? 'info' : 'debug' });
  const db = await openDocStore(config, logger);
  const store = await Store.open(db, (err, id) => logger.error({ err: err.message, exec: id }, 'failed to save execution'));
  const accounts = new Accounts(config, logger.child({ mod: 'accounts' }), db);
  await accounts.init();
  const apiKeys = new ApiKeys(db, scoped(config.env, 'api-keys'), Date.now, (err) => logger.error({ err: err.message }, 'failed to save API key'));
  await apiKeys.init();
  const idempotency = new Idempotency(db, scoped(config.env, 'idempotency'), Date.now, (err) => logger.error({ err: err.message }, 'failed to save idempotency key'));
  await idempotency.init();
  const exchange = new StrikeExchange(config, accounts, logger);
  const manager = new ExecutionManager(config, exchange, store, logger.child({ mod: 'exec' }));
  await exchange.start();
  const app = await buildApp(config, { exchange, manager, store, accounts, apiKeys, idempotency });

  if (!config.liveConfigured) app.log.warn(config.liveNotConfiguredReason);

  // Never crash on a stray async error; log it and keep serving.
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => app.log.error({ err }, 'uncaught exception'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  shutdownHook = async () => {
    await manager.shutdown();
    exchange.stop();
    accounts.stop();
    await app.close();
    await db.close();
  };
  app.log.info(`Argus on ${config.env} (${config.symbol}) via ${exchange.name} at http://localhost:${config.port}`);
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
