/**
 * Bounded exponential backoff with jitter.
 *
 * Only transient failures are retried (rate limits, 5xx, network). A 401 or 402
 * is retried zero times — repeating a bad key or an empty balance only wastes
 * the user's time.
 */
export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  jitterMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(0, options.attempts ?? 2);
  const baseMs = options.baseMs ?? 600;
  const jitterMs = options.jitterMs ?? 300;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) break;
      const delay = baseMs * 2 ** attempt + random() * jitterMs;
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
