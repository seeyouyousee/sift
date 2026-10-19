/**
 * The only module that talks to the network.
 *
 * Every call is: rate-limited (token bucket) → timed out (AbortController) →
 * retried when transient → mapped to a `kind` the UI can act on. Callers never
 * see a raw Response or a DOMException.
 */
import { ApiError, type FetchResponse, type SearchResponse } from './types.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { TokenBucket } from './limiter.js';

export interface SearchApiOptions {
  searchEndpoint: string;
  fetchEndpoint: string;
  /** Read the current key at call time (it can be replaced in settings). */
  getKey: () => string;
  bucket: TokenBucket;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
  onRequest?: (kind: 'search' | 'fetch', url: string) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

function mapHttp(status: number, message: string, code?: string): ApiError {
  if (status === 401) return new ApiError('auth', message || 'API Key 无效', status, code);
  if (status === 402) return new ApiError('payment', message || '账号余额不足', status, code);
  if (status === 403) return new ApiError('forbidden', message || '请求被安全策略拒绝', status, code);
  if (status === 429) return new ApiError('rate', message || '触发限速', status, code);
  if (status === 400 || status === 404) return new ApiError('bad-request', message || `请求不合法（HTTP ${status}）`, status, code);
  if (status >= 500) return new ApiError('server', message || `服务端错误（HTTP ${status}）`, status, code);
  return new ApiError('unknown', message || `HTTP ${status}`, status, code);
}

export class SearchApi {
  private readonly opts: SearchApiOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SearchApiOptions) {
    this.opts = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 25_000;
  }

  /** Run one search. Returns the raw provider payload (`results` may be empty). */
  async search(query: string, options: { count?: number } & RequestOptions = {}): Promise<SearchResponse> {
    const body = {
      query,
      count: options.count ?? 10,
      need_content: false,
    };
    const data = await this.request('search', this.opts.searchEndpoint, body, options.signal);
    if (!data || !Array.isArray(data.results)) {
      throw new ApiError('server', '返回体缺少 results 字段');
    }
    return data as unknown as SearchResponse;
  }

  /** Fetch one page as Markdown text. */
  async fetchPage(url: string, options: RequestOptions = {}): Promise<FetchResponse> {
    let data: Record<string, unknown>;
    try {
      data = await this.request('fetch', this.opts.fetchEndpoint, { url }, options.signal);
    } catch (error) {
      // 404 from /tools/fetch means "no extractable content", which is a very
      // different problem from a malformed request: the page is blocked,
      // paywalled, JS-only, or unreachable by the crawler.
      if (error instanceof ApiError && error.status === 404) {
        throw new ApiError('unfetchable', error.message, 404);
      }
      throw error;
    }
    if (!data || typeof data.content !== 'string') {
      throw new ApiError('server', '返回体缺少 content 字段');
    }
    return { title: typeof data.title === 'string' ? data.title : '', content: data.content };
  }

  private async request(
    kind: 'search' | 'fetch',
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const key = this.opts.getKey();
    if (!key) throw new ApiError('auth', '尚未设置 API Key');

    return withRetry(
      async () => {
        await this.opts.bucket.take();
        this.opts.onRequest?.(kind, url);
        return this.dispatch(url, body, key, signal);
      },
      {
        attempts: this.opts.retry?.attempts ?? 2,
        baseMs: this.opts.retry?.baseMs ?? 600,
        sleep: this.opts.retry?.sleep,
        random: this.opts.retry?.random,
        shouldRetry: (error) => error instanceof ApiError && error.retriable,
      },
    );
  }

  private async dispatch(
    url: string,
    body: Record<string, unknown>,
    key: string,
    external: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    if (external?.aborted) throw new ApiError('aborted', '请求已取消');

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', onExternalAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw new ApiError('timeout', `请求超时（${Math.round(this.timeoutMs / 1000)}s）`);
      if (external?.aborted) throw new ApiError('aborted', '请求已取消');
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError('network', `网络错误：${message}`);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      let code: string | undefined;
      try {
        const payload = (await response.json()) as { error?: { message?: string; code?: string } };
        if (payload?.error?.message) message = payload.error.message;
        code = payload?.error?.code;
      } catch {
        /* non-JSON error body */
      }
      throw mapHttp(response.status, message, code);
    }

    try {
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      throw new ApiError('server', '返回体不是合法 JSON', response.status);
    }
  }
}
