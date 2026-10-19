import { describe, expect, it } from 'vitest';
import { TtlLru } from '../src/core/cache.js';

function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe('TtlLru', () => {
  it('stores, reads, and expires on TTL', () => {
    const c = clock();
    const cache = new TtlLru<string, number>({ ttlMs: 100, maxEntries: 4, now: c.now });

    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);

    c.tick(99);
    expect(cache.get('a')).toBe(1);

    c.tick(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats.misses).toBe(1);
  });

  it('evicts the least recently used entry', () => {
    const cache = new TtlLru<string, number>({ ttlMs: 10_000, maxEntries: 2, now: () => 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    // Touch `a` so `b` becomes the oldest.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('reports a TTL eviction to the listener', () => {
    const c = clock();
    const evicted: Array<[string, string]> = [];
    const cache = new TtlLru<string, number>({
      ttlMs: 10,
      maxEntries: 4,
      now: c.now,
      onEvict: (k, reason) => evicted.push([k, reason]),
    });
    cache.set('x', 1);
    c.tick(11);
    cache.get('x');
    expect(evicted).toEqual([['x', 'ttl']]);
  });

  it('tracks hits and misses', () => {
    const cache = new TtlLru<string, number>({ ttlMs: 10_000, maxEntries: 4, now: () => 0 });
    cache.set('a', 1);
    cache.get('a');
    cache.get('a');
    cache.get('missing');

    expect(cache.stats).toMatchObject({ hits: 2, misses: 1, size: 1 });
    cache.resetStats();
    expect(cache.stats.hits).toBe(0);
  });

  it('clears everything', () => {
    const cache = new TtlLru<string, number>({ ttlMs: 10_000, maxEntries: 4, now: () => 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
