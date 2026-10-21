import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Execution, Market } from './types';

interface LiveState {
  market: Market | null;
  connected: boolean;
  executions: Record<string, Execution>;
}

const Ctx = createContext<LiveState>({ market: null, connected: false, executions: {} });

/** One websocket to /live for the whole app; reconnects with backoff. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [market, setMarket] = useState<Market | null>(null);
  const [connected, setConnected] = useState(false);
  const [executions, setExecutions] = useState<Record<string, Execution>>({});
  const retry = useRef(1000);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let stopped = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/live`);
      ws.onopen = () => {
        setConnected(true);
        retry.current = 1000;
      };
      ws.onmessage = (ev) => {
        let msg: { type: string; market?: Market; execution?: Execution };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type === 'market' && msg.market) setMarket(msg.market);
        else if (msg.type === 'execution' && msg.execution) {
          const e = msg.execution;
          setExecutions((prev) => ({ ...prev, [e.id]: e }));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        timer = window.setTimeout(connect, retry.current);
        retry.current = Math.min(retry.current * 2, 15000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return <Ctx.Provider value={{ market, connected, executions }}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
