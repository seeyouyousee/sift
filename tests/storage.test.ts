import { describe, expect, it } from 'vitest';
import { JsonStore, detectBackend, type StoreBackend } from '../src/core/storage.js';

class MemoryBackend implements StoreBackend {
  private readonly map = new Map<string, string>();
  failOnWrite = false;

  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failOnWrite) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('detectBackend', () => {
  it('returns null when localStorage is absent', () => {
    expect(detectBackend({})).toBeNull();
  });

  it('returns the backend when it round-trips', () => {
    const backend = new MemoryBackend();
    expect(detectBackend({ localStorage: backend })).toBe(backend);
  });

  it('returns null when access throws', () => {
    const hostile = {
      get length(): number {
        throw new Error('SecurityError');
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => undefined,
    };
    expect(detectBackend({ localStorage: hostile })).toBeNull();
  });
});

describe('JsonStore', () => {
  it('round-trips values through the namespace', () => {
    const backend = new MemoryBackend();
    const store = new JsonStore('app', 1, backend);
    store.set('history', ['a', 'b']);
    expect(store.get<string[]>('history', [])).toEqual(['a', 'b']);
    expect(backend.getItem('app.history')).toContain('"a"');
  });

  it('returns the fallback for a missing key', () => {
    const store = new JsonStore('app', 1, new MemoryBackend());
    expect(store.get('nope', { ok: true })).toEqual({ ok: true });
  });

  it('returns the fallback on a version mismatch', () => {
    const backend = new MemoryBackend();
    new JsonStore('app', 1, backend).set('key', 'sk-old');
    const upgraded = new JsonStore('app', 2, backend);
    expect(upgraded.get('key', '')).toBe('');
  });

  it('returns the fallback on corrupted JSON', () => {
    const backend = new MemoryBackend();
    backend.setItem('app.key', '{not json');
    expect(new JsonStore('app', 1, backend).get('key', 'fallback')).toBe('fallback');
  });

  it('works without any backend (memory only)', () => {
    const store = new JsonStore('app', 1, null);
    expect(store.persistent).toBe(false);
    store.set('key', 'sk-mem');
    expect(store.get('key', '')).toBe('sk-mem');
  });

  it('keeps working when the backend throws on write', () => {
    const backend = new MemoryBackend();
    const store = new JsonStore('app', 1, backend);
    backend.failOnWrite = true;
    store.set('key', 'sk-quota');
    expect(store.get('key', '')).toBe('sk-quota');
  });

  it('clears only its own namespace', () => {
    const backend = new MemoryBackend();
    backend.setItem('other.key', 'keep me');
    const store = new JsonStore('app', 1, backend);
    store.set('a', 1);
    store.set('b', 2);
    store.clear();
    expect(store.get('a', 0)).toBe(0);
    expect(store.get('b', 0)).toBe(0);
    expect(backend.getItem('other.key')).toBe('keep me');
  });

  it('removes a single key', () => {
    const store = new JsonStore('app', 1, new MemoryBackend());
    store.set('key', 'v');
    store.remove('key');
    expect(store.get('key', '')).toBe('');
  });
});
