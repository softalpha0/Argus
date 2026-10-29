import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { MarketData } from '../exchange/Exchange.js';
import type { ExecutionManager } from '../engine/ExecutionManager.js';
import type { Execution } from '../engine/Execution.js';
import { canSee } from './routes.js';

interface Client {
  ws: WebSocket;
  owner: string | null;
}

/** Market snapshot shared by /api/market and the live socket. */
export function marketView(market: MarketData, symbol: string, depth = 20) {
  const book = market.book;
  const live = market.isLive;
  const now = Date.now();
  const rules = market.rules;
  return {
    symbol,
    live,
    sequence: book.lastSequence,
    mid: live ? (book.mid()?.toString() ?? null) : null,
    spread: live ? (book.spread()?.toString() ?? null) : null,
    fillRate: { buy: market.model.fillRate('buy', now), sell: market.model.fillRate('sell', now) },
    rules: rules && {
      tickSize: rules.tickSize.toString(),
      stepSize: rules.stepSize.toString(),
      minQty: rules.minQty.toString(),
      minNotional: rules.minNotional.toString(),
    },
    book: live ? book.toJSON(depth) : null,
    recentTrades: market.recentTrades(20).map((t) => ({ id: t.id, price: t.price.toString(), size: t.size.toString(), time: t.time, buyerMaker: t.buyerMaker })),
  };
}

/** WS /live: market (≤ 4/s), execution (on change, ≤ 4/s each), fill, report. */
export function registerLive(
  app: FastifyInstance,
  market: MarketData,
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
  market.on('update', () => (marketDirty = true));
  market.on('state', () => (marketDirty = true));
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
      const text = JSON.stringify({ type: 'market', market: marketView(market, symbol) });
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
    let owner: string | null;
    try {
      owner = ownerOf(req);
    } catch (err) {
      // A bad API key on the socket gets a clear close reason instead of an anonymous feed.
      socket.close(4401, (err as Error).message.slice(0, 120));
      return;
    }
    const c: Client = { ws: socket, owner };
    clients.add(c);
    send(c, { type: 'market', market: marketView(market, symbol) });
    socket.on('close', () => clients.delete(c));
    socket.on('error', () => clients.delete(c));
  });
}
