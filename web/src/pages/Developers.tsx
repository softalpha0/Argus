import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useWallet } from '../lib/wallet';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  limits: { maxOrderUsd: number; dailyUsd: number };
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

interface Webhook {
  id: string;
  url: string;
  createdAt: number;
  lastDelivery?: { at: number; ok: boolean; status: number | null; error: string | null; attempt: number };
}

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900 p-4 font-mono text-[12.5px] leading-6 text-neutral-200">{children}</pre>
);

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-ink-700 pt-8 md:grid-cols-[12rem_minmax(0,1fr)]">
      <div>
        <span className="font-mono text-sm text-maker">{String(n).padStart(2, '0')}</span>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="grid min-w-0 gap-4">{children}</div>
    </section>
  );
}

function Keys() {
  const { me, open } = useWallet();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', maxOrderUsd: '500', dailyUsd: '2000' });
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    api<{ keys: ApiKey[] }>('/api/keys')
      .then((r) => setKeys(r.keys))
      .catch((e: ApiError) => setError(e.message));
  useEffect(() => {
    if (me) void load();
    else setKeys(null);
  }, [me]);

  if (!me) {
    return (
      <div className="panel grid gap-3 p-5">
        <p className="text-neutral-300">Connect the wallet your agent will trade for. API keys act for that wallet's Strike account and can never withdraw.</p>
        <button className="btn-primary w-fit" onClick={() => open('connect')}>Connect wallet</button>
      </div>
    );
  }

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ key: string; apiKey: ApiKey }>('/api/keys', { method: 'POST', json: { name: form.name || undefined, maxOrderUsd: form.maxOrderUsd, dailyUsd: form.dailyUsd } });
      setCreated(r.key);
      setCopied(false);
      setForm({ ...form, name: '' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke "${k.name}"? Programs using it stop working, and any order it is running is stopped.`)) return;
    setError(null);
    try {
      const r = await api<{ stoppedExecutions: number }>(`/api/keys/${k.id}`, { method: 'DELETE' });
      if (r.stoppedExecutions) setError(`Revoked. Stopped ${r.stoppedExecutions} running ${r.stoppedExecutions === 1 ? 'execution' : 'executions'}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid gap-4">
      {created && (
        <div className="panel grid gap-3 border-maker/50 p-5">
          <p className="font-medium text-maker">Copy your new key now. It won't be shown again.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-ink-800 px-3 py-2 font-mono text-sm">{created}</code>
            <button
              className="btn-ghost"
              onClick={() => {
                void navigator.clipboard.writeText(created).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button className="w-fit text-sm text-neutral-400 hover:text-neutral-200" onClick={() => setCreated(null)}>I've saved it</button>
        </div>
      )}

      <div className="panel grid gap-4 p-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="grid gap-1 text-sm">
            <span className="eyebrow">Name</span>
            <input className="rounded-md border border-ink-600 bg-ink-800 px-3 py-2" placeholder="e.g. rebalancing agent" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="eyebrow">Max per order (USD)</span>
            <input className="rounded-md border border-ink-600 bg-ink-800 px-3 py-2 font-mono" inputMode="decimal" value={form.maxOrderUsd} onChange={(e) => setForm({ ...form, maxOrderUsd: e.target.value })} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="eyebrow">Max per day (USD)</span>
            <input className="rounded-md border border-ink-600 bg-ink-800 px-3 py-2 font-mono" inputMode="decimal" value={form.dailyUsd} onChange={(e) => setForm({ ...form, dailyUsd: e.target.value })} />
          </label>
          <button className="btn-primary" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create key'}</button>
        </div>
        <p className="text-xs text-neutral-500">Limits apply to live orders, measured at the mid price when an order starts. Paper orders are free and unlimited.</p>
        {error && <p className="text-sm text-amber-300">{error}</p>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-left">
            <tr>{['Key', 'Limits', 'Created', 'Last used', ''].map((h) => <th key={h} className="eyebrow px-3 py-2 font-normal">{h}</th>)}</tr>
          </thead>
          <tbody>
            {keys === null && <tr><td className="px-3 py-3 text-neutral-500" colSpan={5}>Loading…</td></tr>}
            {keys?.length === 0 && <tr><td className="px-3 py-3 text-neutral-500" colSpan={5}>No keys yet. Create one above.</td></tr>}
            {keys?.map((k) => (
              <tr key={k.id} className={`border-t border-ink-700 align-top ${k.revokedAt ? 'text-neutral-500' : ''}`}>
                <td className="px-3 py-2">
                  <div className="font-medium">{k.name}</div>
                  <div className="font-mono text-xs text-neutral-500">{k.prefix}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">${k.limits.maxOrderUsd.toLocaleString()} / order<br />${k.limits.dailyUsd.toLocaleString()} / day</td>
                <td className="px-3 py-2 text-xs">{when(k.createdAt)}</td>
                <td className="px-3 py-2 text-xs">{when(k.lastUsedAt)}</td>
                <td className="px-3 py-2 text-right">
                  {k.revokedAt ? <span className="text-xs">Revoked {when(k.revokedAt)}</span> : <button className="text-sm text-taker hover:underline" onClick={() => void revoke(k)}>Revoke</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Webhooks() {
  const { me, open } = useWallet();
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    api<{ webhooks: Webhook[] }>('/api/webhooks')
      .then((r) => setHooks(r.webhooks))
      .catch((e: ApiError) => setError(e.message));
  useEffect(() => {
    if (me) void load();
    else setHooks(null);
  }, [me]);

  if (!me) {
    return (
      <div className="panel grid gap-3 p-5">
        <p className="text-neutral-300">Connect your wallet to add webhook endpoints.</p>
        <button className="btn-primary w-fit" onClick={() => open('connect')}>Connect wallet</button>
      </div>
    );
  }

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ secret: string; webhook: Webhook }>('/api/webhooks', { method: 'POST', json: { url } });
      setSecret(r.secret);
      setCopied(false);
      setUrl('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (w: Webhook) => {
    if (!confirm(`Delete the webhook for ${w.url}?`)) return;
    setError(null);
    try {
      await api(`/api/webhooks/${w.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid gap-4">
      {secret && (
        <div className="panel grid gap-3 border-maker/50 p-5">
          <p className="font-medium text-maker">Copy the signing secret now. It won't be shown again.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-ink-800 px-3 py-2 font-mono text-sm">{secret}</code>
            <button className="btn-ghost" onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <button className="w-fit text-sm text-neutral-400 hover:text-neutral-200" onClick={() => setSecret(null)}>I've saved it</button>
        </div>
      )}
      <div className="panel grid gap-3 p-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="grid gap-1 text-sm">
            <span className="eyebrow">Endpoint URL</span>
            <input className="rounded-md border border-ink-600 bg-ink-800 px-3 py-2 font-mono" placeholder="https://example.com/argus" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <button className="btn-primary" disabled={busy || !url} onClick={() => void create()}>{busy ? 'Adding…' : 'Add webhook'}</button>
        </div>
        <p className="text-xs text-neutral-500">Public HTTPS endpoints only. Up to 5 per wallet.</p>
        {error && <p className="text-sm text-amber-300">{error}</p>}
      </div>
      {hooks && hooks.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-ink-700">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left">
              <tr>{['Endpoint', 'Created', 'Last delivery', ''].map((h) => <th key={h} className="eyebrow px-3 py-2 font-normal">{h}</th>)}</tr>
            </thead>
            <tbody>
              {hooks.map((w) => (
                <tr key={w.id} className="border-t border-ink-700 align-top">
                  <td className="break-all px-3 py-2 font-mono text-xs">{w.url}</td>
                  <td className="px-3 py-2 text-xs">{when(w.createdAt)}</td>
                  <td className="px-3 py-2 text-xs">
                    {w.lastDelivery ? (
                      <span className={w.lastDelivery.ok ? 'text-maker' : 'text-taker'}>
                        {w.lastDelivery.ok ? `Delivered (${w.lastDelivery.status})` : `Failed: ${w.lastDelivery.error}`} · {when(w.lastDelivery.at)}
                      </span>
                    ) : (
                      'None yet'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right"><button className="text-sm text-taker hover:underline" onClick={() => void remove(w)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ENDPOINTS: [string, string][] = [
  ['POST /v1/executions', 'Start an execution. Body: mode (paper or live), side, size, deadlineSec, maxSlippageBps, preset, fallback, optional clientRef.'],
  ['GET /v1/executions', 'Your executions, newest first (?limit= up to 100).'],
  ['GET /v1/executions/:id', 'State, filled size, the working order and its place in line, time left.'],
  ['POST /v1/executions/:id/cancel', 'Stop it. Safe to repeat.'],
  ['GET /v1/executions/:id/events', 'Server-Sent Events: execution snapshots, a fill per fill, then the final execution and the receipt.'],
  ['GET /v1/executions/:id/receipt', 'The receipt once finished (409 not_ready before).'],
];

const TOOLS: [string, string][] = [
  ['argus_market', 'Mid, spread and top of book.'],
  ['argus_quote', 'What a market order would cost now versus resting as maker through Argus.'],
  ['argus_execute', 'Start an execution (paper by default) and optionally wait up to 120 s for the receipt.'],
  ['argus_status', 'State, fills and place in line of one execution.'],
  ['argus_receipt', 'The receipt once finished.'],
  ['argus_cancel', 'Stop an execution.'],
  ['argus_list', 'Recent executions.'],
];

const ERRORS = ['invalid_request', 'unauthorized', 'forbidden', 'limit_exceeded', 'not_found', 'conflict', 'idempotency_key_reused', 'not_ready', 'unavailable', 'server_error'];

export default function Developers() {
  const origin = location.origin;
  return (
    <div className="grid gap-12 pb-10">
      <header className="grid max-w-3xl gap-4 pt-4">
        <span className="eyebrow text-maker">Developers</span>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Give your agent an execution layer.</h1>
        <p className="text-lg leading-8 text-neutral-300">
          One API for maker-first execution on Strike: send an order, follow it live, get a receipt. Start in paper mode on the real order book, then switch to live with limits you set.
        </p>
      </header>

      <Step n={1} title="Create an API key">
        <Keys />
      </Step>

      <Step n={2} title="Place your first order">
        <p className="text-neutral-400">Paper mode trades against Strike's live order book without placing real orders. Change <code className="font-mono text-neutral-200">"mode"</code> to <code className="font-mono text-neutral-200">"live"</code> when you're ready.</p>
        <Code>{`curl -X POST ${origin}/v1/executions \\
  -H "authorization: Bearer $ARGUS_KEY" \\
  -H "idempotency-key: $(uuidgen)" \\
  -H "content-type: application/json" \\
  -d '{"mode":"paper","side":"buy","size":"0.002","deadlineSec":300,"maxSlippageBps":10,"fallback":"market"}'

# Follow it live, then read the receipt
curl -N ${origin}/v1/executions/<id>/events -H "authorization: Bearer $ARGUS_KEY"
curl ${origin}/v1/executions/<id>/receipt -H "authorization: Bearer $ARGUS_KEY"`}</Code>
        <p className="text-neutral-400">
          Or run the Node quickstart (no dependencies), which does all three:{' '}
          <a className="text-maker hover:underline" href="https://github.com/softalpha0/Argus/blob/main/examples/quickstart.mjs" target="_blank" rel="noreferrer">examples/quickstart.mjs</a>
        </p>
        <Code>{`ARGUS_KEY=argus_... node examples/quickstart.mjs --side buy --size 0.002 --deadline 120`}</Code>
      </Step>

      <Step n={3} title="API reference">
        <div className="overflow-x-auto rounded-lg border border-ink-700">
          <table className="w-full min-w-[36rem] text-sm">
            <tbody>
              {ENDPOINTS.map(([e, d]) => (
                <tr key={e} className="border-t border-ink-700 align-top first:border-t-0">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12.5px] text-neutral-100">{e}</td>
                  <td className="px-3 py-2 text-neutral-300">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <h3 className="font-medium">Authentication</h3>
            <p className="text-sm leading-6 text-neutral-400">Send <code className="font-mono text-neutral-200">Authorization: Bearer argus_…</code>. A wrong or revoked key gets 401; it is never treated as an anonymous request. Keys can start, follow and stop executions, never deposit, withdraw or manage keys.</p>
          </div>
          <div className="grid content-start gap-2">
            <h3 className="font-medium">Safe retries</h3>
            <p className="text-sm leading-6 text-neutral-400">Send an <code className="font-mono text-neutral-200">Idempotency-Key</code> on POST. A retry with the same key and body returns the execution already started (200, <code className="font-mono text-neutral-200">Idempotent-Replayed: true</code>); a different body gets 409. Keys are kept for 24 hours.</p>
          </div>
          <div className="grid content-start gap-2">
            <h3 className="font-medium">Errors</h3>
            <p className="text-sm leading-6 text-neutral-400">
              <code className="font-mono text-neutral-200">{'{"error":{"type","message"}}'}</code>, where type is one of{' '}
              {ERRORS.map((e, i) => (
                <span key={e}><code className="font-mono text-neutral-200">{e}</code>{i < ERRORS.length - 1 ? ', ' : '.'}</span>
              ))}
            </p>
          </div>
          <div className="grid content-start gap-2">
            <h3 className="font-medium">Receipts</h3>
            <p className="text-sm leading-6 text-neutral-400"><code className="font-mono text-neutral-200">argus.receipt.v1</code>: requested parameters, outcome, timing, arrival price, result, costs (including the builder fee), the saving against a market order at arrival in USD and bps, every fill with fairness checks, and the venue's own order records.</p>
          </div>
        </div>
      </Step>

      <Step n={4} title="Connect an AI agent (MCP)">
        <p className="text-neutral-400">
          Argus is an MCP server, so Claude and other MCP-capable agents can quote, trade, follow and cancel from plain-language instructions. Every tool call runs as your API key, with its limits. Orders are paper unless the agent explicitly asks for live.
        </p>
        <h3 className="font-medium">Remote (recommended)</h3>
        <Code>{`# Claude Code
claude mcp add --transport http argus ${origin}/mcp \\
  --header "Authorization: Bearer $ARGUS_KEY"

# Any MCP client: Streamable HTTP
URL:     ${origin}/mcp
Header:  Authorization: Bearer argus_...`}</Code>
        <h3 className="font-medium">Local (stdio)</h3>
        <Code>{`{
  "mcpServers": {
    "argus": {
      "command": "node",
      "args": ["/path/to/Argus/server/dist/mcp/stdio.js"],
      "env": { "ARGUS_KEY": "argus_...", "ARGUS_URL": "${origin}" }
    }
  }
}`}</Code>
        <div className="overflow-x-auto rounded-lg border border-ink-700">
          <table className="w-full min-w-[36rem] text-sm">
            <tbody>
              {TOOLS.map(([t, d]) => (
                <tr key={t} className="border-t border-ink-700 align-top first:border-t-0">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12.5px] text-neutral-100">{t}</td>
                  <td className="px-3 py-2 text-neutral-300">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-neutral-400">Try: <span className="text-neutral-200">"Check what a market buy of 0.002 BTC would cost, then buy it in paper mode over 45 seconds and tell me how it went from the receipt."</span></p>
      </Step>

      <Step n={5} title="Webhooks">
        <p className="text-neutral-400">
          Get an <code className="font-mono text-neutral-200">execution.finished</code> event, with the execution and its receipt, the moment an order ends. Failed deliveries are retried after 10 seconds, 1 minute and 5 minutes.
        </p>
        <Webhooks />
        <h3 className="font-medium">Verify the signature</h3>
        <p className="text-sm leading-6 text-neutral-400">
          Each delivery carries <code className="font-mono text-neutral-200">Argus-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, an HMAC-SHA256 of <code className="font-mono text-neutral-200">"&lt;t&gt;.&lt;raw body&gt;"</code> with your signing secret. Reject old timestamps, and use <code className="font-mono text-neutral-200">Argus-Event-Id</code> to ignore repeats.
        </p>
        <Code>{`import crypto from 'node:crypto';

function verify(secret, rawBody, header, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (!v1 || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const got = Buffer.from(v1, 'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}`}</Code>
      </Step>

      <Step n={6} title="Coming next">
        <ul className="grid gap-2 text-neutral-300">
          <li className="flex gap-2"><span className="text-queue">→</span>Strike mainnet.</li>
          <li className="flex gap-2"><span className="text-queue">→</span>Ethereum wallets.</li>
          <li className="flex gap-2"><span className="text-queue">→</span>More venues behind the same API.</li>
        </ul>
      </Step>
    </div>
  );
}
