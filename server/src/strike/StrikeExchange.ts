import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Exchange, MarketData, MarketEvents, PublicTrade } from '../exchange/Exchange.js';
import type { Venue } from '../engine/Venue.js';
import { LiveVenue } from '../engine/LiveVenue.js';
import type { Accounts } from '../users/Accounts.js';
import { MarketFeeds } from './feeds.js';
import { fetchBaseFees } from './feeTiers.js';
import { syncClock } from './rest.js';

/** Strike's L3 book, tape and rules behind the generic MarketData interface. */
class StrikeMarket extends EventEmitter<MarketEvents> implements MarketData {
  constructor(private readonly feeds: MarketFeeds, readonly symbol: string) {
    super();
    // MarketFeeds registered the model's listener first, so the model is current when these fire.
    feeds.l3.on('update', (u, res) => this.emit('update', u, res));
    feeds.l3.on('synced', () => this.emit('synced'));
    feeds.l3.on('state', () => this.emit('state'));
  }

  get book() {
    return this.feeds.l3.book;
  }

  get model() {
    return this.feeds.model;
  }

  get isLive() {
    return this.feeds.l3.isLive;
  }

  get rules() {
    return this.feeds.rules;
  }

  recentTrades(limit: number): readonly PublicTrade[] {
    return this.feeds.tape.trades.slice(-limit);
  }

  health() {
    return { sync: { ...this.feeds.l3.stats }, tape: { connected: this.feeds.tape.connected, trades: this.feeds.tape.tradesSeen } };
  }
}

export class StrikeExchange implements Exchange {
  readonly id = 'strike';
  readonly name = 'Strike Finance';
  readonly market: StrikeMarket;
  private readonly feeds: MarketFeeds;
  private clockTimer: NodeJS.Timeout | null = null;

  /** `accounts` is needed for live trading; scripts that only paper trade can pass null. */
  constructor(
    private readonly config: Config,
    private readonly accounts: Accounts | null,
    private readonly logger: Logger,
  ) {
    this.feeds = new MarketFeeds(config, logger);
    this.market = new StrikeMarket(this.feeds, config.symbol);
  }

  async start(): Promise<void> {
    if (!this.config.feesPinned) {
      try {
        Object.assign(this.config, await fetchBaseFees(this.config.hosts.rest));
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'could not read Strike fee tiers; using built-in base fees');
      }
    }
    this.logger.info({ takerFee: this.config.takerFee, makerFee: this.config.makerFee }, 'fees for paper fills and estimates');
    const resync = () =>
      syncClock(this.config.hosts.rest)
        .then((skew) => Math.abs(skew) > 2000 && this.logger.warn({ skewMs: Math.round(skew) }, 'local clock differs from Strike; correcting signatures'))
        .catch((err) => this.logger.warn({ err: (err as Error).message }, 'could not read Strike server time'));
    void resync();
    this.clockTimer = setInterval(() => void resync(), 10 * 60_000);
    this.clockTimer.unref();
    // Feeds retry in the background until rules load; don't hold up the server for them.
    void this.feeds.start();
  }

  async createLiveVenue(owner: string, executionId: string): Promise<Venue> {
    if (!this.accounts) throw new Error('Live trading is not available here');
    const rest = this.accounts.restFor(owner);
    const stream = this.accounts.streamFor(owner);
    // The stream must be up before the first order, or we'd miss its confirmation.
    await stream.waitReady(10_000);
    return new LiveVenue({
      symbol: this.config.symbol,
      rest,
      stream,
      l3: this.feeds.l3,
      tape: this.feeds.tape,
      argusFeeBps: this.config.argusFeeBps,
      logger: this.logger.child({ mod: 'live', exec: executionId }),
    });
  }

  stop(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.feeds.stop();
  }
}
