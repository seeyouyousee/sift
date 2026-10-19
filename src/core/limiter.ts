/**
 * Token bucket with a queue.
 *
 * The provider limits an account to 5 requests/second. Exceeding it yields HTTP
 * 429, which is both a failure and (worse) a billable-waste signal. Rather than
 * dropping requests, this bucket makes callers *wait*: a burst of 20 clicks
 * drains at 5/s instead of failing.
 *
 * Clock and timer are injectable so the tests can run instantly and
 * deterministically.
 */
export interface TokenBucketOptions {
  /** Tokens added per second. */
  rate: number;
  /** Maximum accumulated tokens (burst size). Defaults to `rate`. */
  capacity?: number;
  /** Milliseconds clock; defaults to `performance.now`. */
  now?: () => number;
  /** Timer; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown;
}

export class TokenBucket {
  private readonly rate: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;

  private tokens: number;
  private last: number;
  private waiting = 0;

  constructor(options: TokenBucketOptions) {
    this.rate = options.rate;
    this.capacity = options.capacity ?? options.rate;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.tokens = this.capacity;
    this.last = this.now();
  }

  /** Resolves when a token is available. Never rejects. */
  take(): Promise<void> {
    this.waiting++;
    return new Promise<void>((resolve) => {
      const attempt = () => {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          this.waiting--;
          resolve();
          return;
        }
        const deficit = 1 - this.tokens;
        const waitMs = Math.max(16, Math.ceil((deficit / this.rate) * 1000));
        this.schedule(attempt, waitMs);
      };
      attempt();
    });
  }

  /** Tokens available right now (after refilling). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Callers currently waiting for a token. */
  get queued(): number {
    return this.waiting;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.rate);
  }
}
