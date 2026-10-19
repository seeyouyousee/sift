/**
 * Central configuration. Everything user-visible or price-related lives here so
 * the fork-and-rebrand path is a single file.
 */
export const CONFIG = {
  /** Shown in the header and the document title. */
  brand: 'Sift',
  tagline: '带自己的 key，搜自己的网',

  /** DeepSeek Search & Fetch endpoints (see docs.deepseek.com). */
  searchEndpoint: 'https://api.deepseek.com/v1/tools/search',
  fetchEndpoint: 'https://api.deepseek.com/v1/tools/fetch',

  /** Provider hard limits. */
  maxCount: 50,
  qps: 5,
  pricePerSuccessfulSearch: 5 / 1000,

  /** Defaults baked into the UI; the settings drawer can override page size. */
  defaultPageSize: 10,
  pageSizes: [10, 20, 50] as const,

  /** Client-side cache. Empty result sets are never cached. */
  cacheTtlMs: 10 * 60 * 1000,
  cacheMaxEntries: 60,

  /** Network. */
  requestTimeoutMs: 25_000,
  retryAttempts: 2,
  retryBaseMs: 600,

  /** localStorage namespaces. */
  storageNamespace: 'sift',
  storageVersion: 1,
} as const;

export type Config = typeof CONFIG;
