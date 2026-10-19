import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/core/retry.js';

const noSleep = () => Promise.resolve();

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures up to `attempts`', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'recovered';
      },
      { attempts: 2, sleep: noSleep },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('rethrows after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { attempts: 2, sleep: noSleep },
      ),
    ).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });

  it('does not retry when shouldRetry says no', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('fatal');
        },
        { attempts: 3, shouldRetry: () => false, sleep: noSleep },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('backs off exponentially with jitter', async () => {
    const delays: number[] = [];
    await withRetry(
      async () => {
        throw new Error('x');
      },
      {
        attempts: 3,
        baseMs: 100,
        jitterMs: 0,
        random: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    ).catch(() => undefined);

    expect(delays).toEqual([100, 200, 400]);
  });

  it('reports each retry', async () => {
    const seen: number[] = [];
    await withRetry(
      async () => {
        throw new Error('x');
      },
      {
        attempts: 2,
        sleep: noSleep,
        random: () => 0,
        onRetry: (_error, attempt) => seen.push(attempt),
      },
    ).catch(() => undefined);

    expect(seen).toEqual([1, 2]);
  });
});
