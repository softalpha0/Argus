import { describe, expect, it } from 'vitest';
import { canSee, parseExecutionBody } from '../src/api/routes.js';

describe('parseExecutionBody', () => {
  it('fills defaults', () => {
    const p = parseExecutionBody({ side: 'buy', size: '0.002' });
    expect(p).toMatchObject({ mode: 'paper', side: 'buy', deadlineSec: 300, maxSlippageBps: 10, preset: 'balanced', fallback: 'market' });
    expect(p.size.toString()).toBe('0.002');
  });

  it('rejects bad input with clear messages', () => {
    expect(() => parseExecutionBody({ side: 'long', size: '1' })).toThrow(/side/);
    expect(() => parseExecutionBody({ side: 'buy' })).toThrow(/size is required/);
    expect(() => parseExecutionBody({ side: 'buy', size: 'abc' })).toThrow(/number/);
    expect(() => parseExecutionBody({ side: 'buy', size: '-1' })).toThrow(/greater than 0/);
    expect(() => parseExecutionBody({ side: 'buy', size: '1', deadlineSec: 5 })).toThrow(/deadlineSec/);
    expect(() => parseExecutionBody({ side: 'buy', size: '1', maxSlippageBps: 0 })).toThrow(/maxSlippageBps/);
    expect(() => parseExecutionBody({ side: 'buy', size: '1', preset: 'toString' })).toThrow(/preset/);
    expect(() => parseExecutionBody({ side: 'buy', size: '1', preset: 'yolo' })).toThrow(/preset/);
    expect(() => parseExecutionBody({ side: 'buy', size: '1', fallback: 'hope' })).toThrow(/fallback/);
    expect(() => parseExecutionBody(null)).toThrow();
  });
});

describe('canSee', () => {
  it('keeps live executions private to their owner', () => {
    expect(canSee({ mode: 'paper', owner: null }, null)).toBe(true);
    expect(canSee({ mode: 'live', owner: 'W1' }, null)).toBe(false);
    expect(canSee({ mode: 'live', owner: 'W1' }, 'W2')).toBe(false);
    expect(canSee({ mode: 'live', owner: 'W1' }, 'W1')).toBe(true);
  });
});

describe('GET /api/reports/:id', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerRoutes } = await import('../src/api/routes.js');
  const { loadConfig } = await import('../src/config.js');
  it('includes the orders as Strike reports them', async () => {
    const stored = { id: 'r1', mode: 'live', owner: 'W1', side: 'buy', size: '0.001', state: 'done', createdAt: 1, endedAt: 2, report: { steps: [] }, fills: [], events: [], audit: { orders: [{ clientOrderId: 'argus-r1-1', id: 42, builder: { Code: 'Argus', FeeBps: 2 } }] } };
    const app = Fastify();
    registerRoutes(app, {
      config: loadConfig({}),
      manager: { get: () => ({ stored }) } as never,
      store: { all: () => [] } as never,
      ownerOf: () => 'W1',
    });
    const res = await app.inject({ method: 'GET', url: '/api/reports/r1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().audit.orders[0]).toMatchObject({ id: 42, builder: { Code: 'Argus', FeeBps: 2 } });
    const hidden = await (async () => {
      const a2 = Fastify();
      registerRoutes(a2, { config: loadConfig({}), manager: { get: () => ({ stored }) } as never, store: { all: () => [] } as never, ownerOf: () => 'someone-else' });
      return a2.inject({ method: 'GET', url: '/api/reports/r1' });
    })();
    expect(hidden.statusCode).toBe(404);
  });
});
