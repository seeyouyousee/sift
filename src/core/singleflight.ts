/**
 * Collapse concurrent identical work into a single in-flight promise.
 *
 * Two users (or two tabs) searching the same phrase at the same moment must not
 * produce two billable upstream calls. The loser of the race awaits the winner
 * and gets the same value; both count as cache hits for display purposes.
 */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` once per key while it is pending.
   *
   * @param key - identity of the work
   * @param fn - producer; may reject, which propagates to every waiter and then
   *   clears the slot so a later call can retry
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => fn())();
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  get size(): number {
    return this.inflight.size;
  }
}
