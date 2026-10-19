/**
 * Namespaced, versioned localStorage access.
 *
 * Everything persisted here is user-local state (API key, history, settings).
 * Three real-world constraints drive the design:
 *  - Safari private mode and some `file://` contexts throw on access, so the
 *    backend is detected once and may be `null` (memory-only fallback);
 *  - schema changes must not crash an existing install, hence the version
 *    envelope and silent reset on mismatch;
 *  - a malformed value must never block the app from starting.
 */
export interface StoreBackend {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Envelope<T> {
  v: number;
  d: T;
}

/** Return `localStorage` if it is actually usable, else `null`. */
export function detectBackend(scope: { localStorage?: unknown } = globalThis as { localStorage?: unknown }): StoreBackend | null {
  try {
    const store = scope.localStorage as StoreBackend | undefined;
    if (!store) return null;
    const probe = '__sift_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

export class JsonStore {
  private readonly ns: string;
  private readonly version: number;
  private readonly backend: StoreBackend | null;
  private readonly memory = new Map<string, string>();
  /** Set once a write fails; reads then prefer the in-memory copy. */
  private degraded = false;

  constructor(namespace: string, version: number, backend: StoreBackend | null) {
    this.ns = namespace;
    this.version = version;
    this.backend = backend;
  }

  /** True when values survive a reload. */
  get persistent(): boolean {
    return this.backend !== null;
  }

  get<T>(key: string, fallback: T): T {
    const raw = this.rawGet(this.fullKey(key));
    if (raw === null) return fallback;
    try {
      const parsed = JSON.parse(raw) as Envelope<T> | T;
      if (parsed && typeof parsed === 'object' && 'v' in (parsed as object) && 'd' in (parsed as object)) {
        const env = parsed as Envelope<T>;
        if (env.v !== this.version) return fallback;
        return env.d;
      }
      return parsed as T;
    } catch {
      return fallback;
    }
  }

  set<T>(key: string, value: T): void {
    const payload = JSON.stringify({ v: this.version, d: value } satisfies Envelope<T>);
    this.rawSet(this.fullKey(key), payload);
  }

  remove(key: string): void {
    this.rawSet(this.fullKey(key), null);
  }

  clear(): void {
    const prefix = `${this.ns}.`;
    if (this.backend) {
      try {
        const keys: string[] = [];
        for (let i = 0; i < this.backend.length; i++) {
          const k = this.backend.key(i);
          if (k && k.startsWith(prefix)) keys.push(k);
        }
        for (const k of keys) this.backend.removeItem(k);
      } catch {
        /* fall through to memory clear */
      }
    }
    this.memory.clear();
  }

  private fullKey(key: string): string {
    return `${this.ns}.${key}`;
  }

  private rawGet(key: string): string | null {
    if (this.degraded) {
      const value = this.memory.get(key);
      if (value !== undefined) return value;
    }
    if (this.backend) {
      try {
        return this.backend.getItem(key);
      } catch {
        return this.memory.get(key) ?? null;
      }
    }
    return this.memory.get(key) ?? null;
  }

  private rawSet(key: string, value: string | null): void {
    if (value === null) {
      this.memory.delete(key);
      try {
        this.backend?.removeItem(key);
      } catch {
        /* ignore */
      }
      return;
    }
    this.memory.set(key, value);
    try {
      this.backend?.setItem(key, value);
    } catch {
      // Quota exceeded / private mode: memory keeps the session usable, and
      // reads must stop going to the (now stale) backend.
      this.degraded = true;
    }
  }
}
