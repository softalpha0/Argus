import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { L3Client } from './l3Client.js';
import { TapeClient } from './tapeClient.js';
import { fetchSymbolRules, type SymbolRules } from './exchangeInfo.js';
import { Backoff } from './backoff.js';
import { MarketModel } from '../model/MarketModel.js';

/** Public market data shared by every execution: exchange rules, L3 book, trade tape. */
export class MarketFeeds {
  readonly l3: L3Client;
  readonly tape: TapeClient;
  readonly model: MarketModel;
  rules: SymbolRules | null = null;
  private rulesTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config, private readonly logger: Logger) {
    this.l3 = new L3Client({ symbol: config.symbol, wsUrl: config.hosts.l3Ws, restUrl: config.hosts.rest, logger: logger.child({ mod: 'l3' }) });
    this.tape = new TapeClient({ symbol: config.symbol, wsUrl: config.hosts.priceWs, logger: logger.child({ mod: 'tape' }) });
    this.model = new MarketModel(this.l3.book);
    // Listeners registered here run before any added later, so the model is current for executions.
    this.l3.on('update', (u, res) => this.model.onUpdate(u, res));
    this.l3.on('synced', ({ book }) => this.model.markStart(book.lastTimestamp));
  }

  async start(): Promise<void> {
    await this.loadRules();
    this.l3.start();
    this.tape.start();
  }

  stop(): void {
    this.l3.stop();
    this.tape.stop();
    if (this.rulesTimer) clearTimeout(this.rulesTimer);
  }

  /** Loads exchange rules, retrying in the background until it works. */
  private async loadRules(): Promise<void> {
    const backoff = new Backoff(1000, 30_000);
    for (;;) {
      try {
        this.rules = await fetchSymbolRules(this.config.hosts.marketRest, this.config.symbol);
        this.logger.info(
          { tick: this.rules.tickSize.toString(), step: this.rules.stepSize.toString(), minQty: this.rules.minQty.toString(), minNotional: this.rules.minNotional.toString() },
          'exchange info loaded',
        );
        // Refresh hourly in case filters change.
        this.rulesTimer = setTimeout(() => void this.loadRules(), 60 * 60_000);
        return;
      } catch (err) {
        const delay = backoff.next();
        this.logger.warn({ err: (err as Error).message, retryMs: delay }, 'exchange info failed');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
