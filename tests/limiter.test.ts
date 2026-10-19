import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/core/limiter.js';

/** Deterministic clock + timer queue. */
function fakeClock() {
  let now = 0;
  let queue: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      queue.push({ at: now + ms, fn });
      return queue.length;
    },
    async advance(ms: number) {
      const target = now + ms;
      // Drain due timers in order, allowing handlers to schedule more work.
      for (;;) {
        const due = queue.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        queue = queue.filter((t) => t !== due);
        now = due.at;
        due.fn();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

describe('TokenBucket', () => {
  it('serves the initial burst instantly', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ rate: 5, now: clock.now, schedule: clock.schedule });
    expect(bucket.available()).toBe(5);

    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      await bucket.take();
      order.push(i);
    }
    expect(order).toHaveLength(5);
    expect(bucket.available()).toBe(0);
  });

  it('queues past the burst instead of dropping', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ rate: 5, now: clock.now, schedule: clock.schedule });

    const resolved: number[] = [];
    for (let i = 0; i < 5; i++) await bucket.take();

    const pending = bucket.take().then(() => resolved.push(1));
    expect(resolved).toHaveLength(0);
    expect(bucket.queued).toBe(1);

    // 5 tokens/s → 200ms for the next one.
    await clock.advance(199);
    expect(resolved).toHaveLength(0);
    await clock.advance(2);
    await pending;
    expect(resolved).toHaveLength(1);
    expect(bucket.queued).toBe(0);
  });

  it('refills up to capacity, never beyond', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ rate: 5, capacity: 10, now: clock.now, schedule: clock.schedule });
    await clock.advance(60_000);
    expect(bucket.available()).toBe(10);
  });

  it('does three callers one token apart', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ rate: 5, capacity: 1, now: clock.now, schedule: clock.schedule });
    const done: number[] = [];
    const jobs = [0, 1, 2].map((i) => bucket.take().then(() => done.push(i)));
    expect(bucket.queued).toBe(2);

    await clock.advance(200);
    await Promise.resolve();
    await clock.advance(200);
    await Promise.resolve();
    await clock.advance(200);
    await Promise.all(jobs);
    expect(done).toEqual([0, 1, 2]);
  });
});
