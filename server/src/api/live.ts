import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { MarketFeeds } from '../strike/feeds.js';
import type { ExecutionManager } from '../engine/ExecutionManager.js';
import type { Execution } from '../engine/Execution.js';
import { canSee } from './routes.js';

interface Client {
  ws: WebSocket;
  owner: string | null;
}

/** Market snapshot shared by /api/market and the live socket. */
export function marketView(feeds: MarketFeeds, symbol: string, depth = 20) {
  const book = feeds.l3.book;
  const live = feeds.l3.isLive;
  const now = Date.now();
  const rules = feeds.rules;
  return {
    symbol,
    live,
    sequence: book.lastSequence,
    mid: live ? (book.mid()?.toString() ?? null) : null,
    spread: live ? (book.spread()?.toString() ?? null) : null,
    fillRate: { buy: feeds.model.fillRate('buy', now), sell: feeds.model.fillRate('sell', now) },
    rules: rules && {
      tickSize: rules.tickSize.toString(),
      stepSize: rules.stepSize.toString(),
      minQty: rules.minQty.toString(),
      minNotional: rules.minNotional.toString(),
    },
    book: live ? book.toJSON(depth) : null,
    recentTrades: feeds.tape.trades.slice(-20).map((t) => ({ id: t.id, price: t.price.toString(), size: t.size.toString(), time: t.time, buyerMaker: t.buyerMaker })),
  };
}

/** WS /live: market (≤ 4/s), execution (on change, ≤ 4/s each), fill, report. */
export function registerLive(
  app: FastifyInstance,
  feeds: MarketFeeds,
  manager: ExecutionManager,
  symbol: string,
  ownerOf: (req: FastifyRequest) => string | null,
): void {
  const clients = new Set<Client>();

  const send = (c: Client, msg: unknown) => {
    if (c.ws.readyState !== 1) return;
    try {
      c.ws.send(JSON.stringify(msg));
    } catch {
      /* close handler cleans up */
    }
  };
  const broadcastExec = (e: Execution, msg: unknown) => {
    for (const c of clients) if (canSee({ mode: e.params.mode, owner: e.owner }, c.owner)) send(c, msg);
  };

  let marketDirty = true;
  feeds.l3.on('update', () => (marketDirty = true));
  feeds.l3.on('state', () => (marketDirty = true));
  const dirtyExecs = new Map<string, Execution>();
  manager.on('change', (e) => dirtyExecs.set(e.id, e));
  manager.on('fill', (e, f) => broadcastExec(e, { type: 'fill', executionId: e.id, fill: f }));
  manager.on('done', (e) => {
    dirtyExecs.delete(e.id);
    broadcastExec(e, { type: 'execution', execution: e.toJSON() });
    broadcastExec(e, { type: 'report', executionId: e.id, report: e.report });
  });

  const timer = setInterval(() => {
    if (clients.size === 0) return;
    if (marketDirty) {
      marketDirty = false;
      const text = JSON.stringify({ type: 'market', market: marketView(feeds, symbol) });
      for (const c of clients) {
        if (c.ws.readyState !== 1) continue;
        try {
          c.ws.send(text);
        } catch {
          /* ignore */
        }
      }
    }
    for (const e of dirtyExecs.values()) broadcastExec(e, { type: 'execution', execution: e.toJSON() });
    dirtyExecs.clear();
  }, 250);
  // Running executions change every second (countdown, queue); refresh them even without events.
  const tick = setInterval(() => {
    for (const e of manager.running()) dirtyExecs.set(e.id, e);
  }, 1000);
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(tick);
  });

  app.get('/live', { websocket: true }, (socket, req) => {
    const c: Client = { ws: socket, owner: ownerOf(req) };
    clients.add(c);
    send(c, { type: 'market', market: marketView(feeds, symbol) });
    socket.on('close', () => clients.delete(c));
    socket.on('error', () => clients.delete(c));
  });
}
