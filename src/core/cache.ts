/**
 * A tiny TTL + LRU cache for search responses.
 *
 * Two constraints shape this: a search costs money (so repeats must not hit the
 * network) and the account is capped at 5 QPS (so repeats must not consume
 * budget either). Recency is tracked by re-inserting on read, which is enough
 * for the ≤100-entry scale of a single browser tab.
 */
export interface TtlLruOptions<K> {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
  /** Optional listener for evictions, used by the UI to show cache stats. */
  onEvict?: (key: K, reason: 'ttl' | 'lru' | 'clear') => void;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlLru<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onEvict: TtlLruOptions<K>['onEvict'];

  private hits = 0;
  private misses = 0;

  constructor(options: TtlLruOptions<K>) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? (() => Date.now());
    this.onEvict = options.onEvict;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      this.onEvict?.(key, 'ttl');
      this.misses++;
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.onEvict?.(oldest.value, 'lru');
    }
  }

  delete(key: K): void {
    if (this.map.delete(key)) this.onEvict?.(key, 'clear');
  }

  clear(): void {
    for (const key of this.map.keys()) this.onEvict?.(key, 'clear');
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}
