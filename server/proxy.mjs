#!/usr/bin/env node
/**
 * Optional proxy: keep the API key on the server instead of in each browser.
 *
 * Two deployments:
 *   1. BYOK through your domain  — no DEEPSEEK_API_KEY set; the client's own
 *      Authorization header is forwarded untouched.
 *   2. Shared key                — DEEPSEEK_API_KEY set; the server injects it
 *      and pays. This is the only mode where you must think about abuse:
 *      the pacer below is the account-level 5 QPS, and `--max-wait` is the
 *      queue you are willing to make a stranger wait.
 *
 * Deliberately dependency-free so it can be dropped next to `dist/` and started
 * with plain `node`.
 */
import { createServer } from 'node:http';

const DEFAULT_UPSTREAM = 'https://api.deepseek.com';
const ROUTES = {
  '/v1/tools/search': '/v1/tools/search',
  '/v1/tools/fetch': '/v1/tools/fetch',
};

/**
 * Space requests `1000/qps` ms apart (leaky bucket).
 *
 * Returns the delay to wait, or `null` when the queue is already longer than
 * `maxWaitMs` — the caller should answer 429 rather than let the queue grow.
 */
function createPacer({ qps, maxWaitMs }) {
  let nextSlot = 0;
  return () => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    const wait = slot - now;
    if (wait > maxWaitMs) return null;
    nextSlot = slot + 1000 / qps;
    return wait;
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createProxy({
  upstream = DEFAULT_UPSTREAM,
  apiKey = '',
  qps = 5,
  maxWaitMs = 4000,
  allowOrigin = '*',
  maxBodyBytes = 64 * 1024,
  timeoutMs = 30_000,
  fetchImpl = fetch,
} = {}) {
  const pacer = createPacer({ qps, maxWaitMs });

  const cors = (origin) => ({
    'Access-Control-Allow-Origin': allowOrigin === '*' ? '*' : allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers = cors(req.headers.origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers).end();
      return;
    }

    const target = ROUTES[url.pathname];
    if (!target) {
      res.writeHead(404, { ...headers, 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: { message: 'not found' } }),
      );
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...headers, Allow: 'POST', 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: { message: 'method not allowed' } }),
      );
      return;
    }

    const wait = pacer();
    if (wait === null) {
      res
        .writeHead(429, { ...headers, 'Retry-After': '1', 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'proxy queue full, retry shortly' } }));
      return;
    }
    if (wait > 0) await sleep(wait);

    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > maxBodyBytes) throw new Error('body too large');
      }
    } catch {
      res.writeHead(413, { ...headers, 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: { message: 'request body too large' } }),
      );
      return;
    }

    const auth = apiKey ? `Bearer ${apiKey}` : (req.headers.authorization ?? '');
    if (!auth) {
      res.writeHead(401, { ...headers, 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: { message: 'missing API key' } }),
      );
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstreamRes = await fetchImpl(`${upstream}${target}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body,
        signal: controller.signal,
      });
      const payload = await upstreamRes.text();
      res
        .writeHead(upstreamRes.status, {
          ...headers,
          'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json',
          'X-Proxy-Status': String(upstreamRes.status),
        })
        .end(payload);
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      res
        .writeHead(aborted ? 504 : 502, { ...headers, 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({
            error: { message: aborted ? 'upstream timeout' : `upstream error: ${String(error)}` },
          }),
        );
    } finally {
      clearTimeout(timer);
    }
  });

  return server;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const qps = Number(process.env.QPS ?? 5);
  const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
  const allowOrigin = process.env.ALLOW_ORIGIN ?? '*';
  const upstream = process.env.DEEPSEEK_BASE ?? DEFAULT_UPSTREAM;

  const server = createProxy({ upstream, apiKey, qps, allowOrigin });
  server.listen(port, '127.0.0.1', () => {
    console.log(`proxy → http://127.0.0.1:${port}`);
    console.log(`  upstream : ${upstream}`);
    console.log(`  key      : ${apiKey ? 'server-side (shared)' : 'forwarded from client (BYOK)'}`);
    console.log(`  origin   : ${allowOrigin}`);
    console.log(`  pacing   : ${qps} req/s`);
  });
}
