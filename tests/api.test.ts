import { describe, expect, it, vi } from 'vitest';
import { SearchApi } from '../src/core/api.js';
import { TokenBucket } from '../src/core/limiter.js';
import { ApiError } from '../src/core/types.js';

function client(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof SearchApi>[0]> = {}) {
  return new SearchApi({
    searchEndpoint: 'https://api.test/v1/tools/search',
    fetchEndpoint: 'https://api.test/v1/tools/fetch',
    getKey: () => 'sk-test-key',
    bucket: new TokenBucket({ rate: 1000 }),
    fetchImpl,
    retry: { sleep: async () => undefined, random: () => 0 },
    ...overrides,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SearchApi.search', () => {
  it('posts query/count/need_content with bearer auth', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    await client(fetchImpl as unknown as typeof fetch).search('deepseek', { count: 50 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/tools/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key');
    expect(JSON.parse(String(init.body))).toEqual({ query: 'deepseek', count: 50, need_content: false });
  });

  it('maps 401 to an auth error', async () => {
    const fetchImpl = async () => json({ error: { message: 'Authentication Fails' } }, 401);
    await expect(client(fetchImpl as never).search('x')).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('maps 402 to a payment error', async () => {
    const fetchImpl = async () => json({ error: { message: 'Insufficient Balance' } }, 402);
    await expect(client(fetchImpl as never).search('x')).rejects.toMatchObject({ kind: 'payment' });
  });

  it('maps 400 to a bad-request error and does not retry it', async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: "'count' must be between 1 and 50" } }, 400));
    const err = await client(fetchImpl as unknown as typeof fetch)
      .search('x')
      .then(() => null, (e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.kind).toBe('bad-request');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and succeeds on the next attempt', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? json({ error: { message: 'rate limited' } }, 429) : json({ results: [{ url: 'https://a' }] });
    });
    const res = await client(fetchImpl as unknown as typeof fetch).search('x');
    expect(calls).toBe(2);
    expect(res.results).toHaveLength(1);
  });

  it('gives up after retry attempts and surfaces the last error', async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: 'rate limited' } }, 429));
    await expect(client(fetchImpl as unknown as typeof fetch).search('x')).rejects.toMatchObject({ kind: 'rate' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('maps a thrown fetch to a network error', async () => {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(client(fetchImpl as never).search('x')).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps an aborted-by-timeout request to timeout', async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    await expect(client(fetchImpl as never, { timeoutMs: 10 }).search('x')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('rejects before the network when no key is set', async () => {
    const fetchImpl = vi.fn();
    const api = client(fetchImpl as never, { getKey: () => '' });
    await expect(api.search('x')).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a payload without results', async () => {
    const fetchImpl = async () => json({ ok: true });
    await expect(client(fetchImpl as never).search('x')).rejects.toMatchObject({ kind: 'server' });
  });

  it('rejects invalid JSON with a server error', async () => {
    const fetchImpl = async () => new Response('not json', { status: 200 });
    await expect(client(fetchImpl as never).search('x')).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('SearchApi.fetchPage', () => {
  it('returns title and content', async () => {
    const fetchImpl = vi.fn(async () => json({ title: 'T', content: '# body' }));
    const page = await client(fetchImpl as unknown as typeof fetch).fetchPage('https://a');
    expect(page).toEqual({ title: 'T', content: '# body' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://a' });
  });

  it('maps 404 to unfetchable (page blocked or unparseable)', async () => {
    const fetchImpl = async () => json({ error: { message: 'failed to fetch URL' } }, 404);
    await expect(client(fetchImpl as never).fetchPage('https://a')).rejects.toMatchObject({ kind: 'unfetchable', status: 404 });
  });

  it('rejects a payload without content', async () => {
    const fetchImpl = async () => json({ title: 'T' });
    await expect(client(fetchImpl as never).fetchPage('https://a')).rejects.toMatchObject({ kind: 'server' });
  });
});
