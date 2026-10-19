import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProxy } from '../server/proxy.mjs';

const open: Server[] = [];

function listen(server: Server): Promise<number> {
  open.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** Upstream stub that echoes what it received and can reject a given key. */
function fakeUpstream(): Server {
  return createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const auth = req.headers.authorization ?? '';
    if (auth === 'Bearer bad-key') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: { message: 'Authentication Fails' } }),
      );
      return;
    }
    if (req.url?.endsWith('/tools/fetch')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ title: 'T', content: 'body', auth, echo: JSON.parse(body) }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ results: [{ url: 'https://example.com' }], auth, echo: JSON.parse(body) }),
    );
  });
}

async function start(options: Parameters<typeof createProxy>[0] = {}) {
  const upstreamPort = await listen(fakeUpstream());
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upstreamPort}`, ...options });
  const port = await listen(proxy);
  return { base: `http://127.0.0.1:${port}`, port };
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('proxy: forwarding', () => {
  it('injects the server-side key and forwards the body', async () => {
    const { base } = await start({ apiKey: 'sk-server' });
    const res = await post(`${base}/v1/tools/search`, { query: 'x', count: 5 });
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.auth).toBe('Bearer sk-server');
    expect(payload.echo).toEqual({ query: 'x', count: 5 });
  });

  it('forwards the client key when no server key is configured (BYOK)', async () => {
    const { base } = await start({ apiKey: '' });
    const res = await post(`${base}/v1/tools/search`, { query: 'x' }, { Authorization: 'Bearer sk-client' });
    expect((await res.json()).auth).toBe('Bearer sk-client');
  });

  it('routes fetch calls to the fetch endpoint', async () => {
    const { base } = await start({ apiKey: 'sk-server' });
    const res = await post(`${base}/v1/tools/fetch`, { url: 'https://example.com' });
    const payload = await res.json();
    expect(payload.content).toBe('body');
    expect(payload.echo).toEqual({ url: 'https://example.com' });
  });

  it('passes an upstream 401 through unchanged', async () => {
    const { base } = await start({ apiKey: 'bad-key' });
    const res = await post(`${base}/v1/tools/search`, { query: 'x' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain('Authentication');
  });
});

describe('proxy: guards', () => {
  it('answers preflight with CORS headers', async () => {
    const { base } = await start({ apiKey: 'k', allowOrigin: 'http://127.0.0.1:8765' });
    const res = await fetch(`${base}/v1/tools/search`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:8765', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8765');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('rejects 401 when neither side has a key', async () => {
    const { base } = await start({ apiKey: '' });
    const res = await post(`${base}/v1/tools/search`, { query: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects unknown paths with 404', async () => {
    const { base } = await start({ apiKey: 'k' });
    const res = await post(`${base}/v1/chat`, {});
    expect(res.status).toBe(404);
  });

  it('rejects non-POST with 405', async () => {
    const { base } = await start({ apiKey: 'k' });
    const res = await fetch(`${base}/v1/tools/search`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('rejects an oversized body with 413', async () => {
    const { base } = await start({ apiKey: 'k', maxBodyBytes: 32 });
    const res = await post(`${base}/v1/tools/search`, { query: 'x'.repeat(200) });
    expect(res.status).toBe(413);
  });

  it('answers 429 when the pacing queue is over the limit', async () => {
    const { base } = await start({ apiKey: 'k', qps: 1, maxWaitMs: 0 });
    const first = await post(`${base}/v1/tools/search`, { query: 'a' });
    expect(first.status).toBe(200);
    const second = await post(`${base}/v1/tools/search`, { query: 'b' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
  });
});
