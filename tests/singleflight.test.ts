import { describe, expect, it } from 'vitest';
import { SingleFlight } from '../src/core/singleflight.js';

const defer = () => {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('SingleFlight', () => {
  it('runs the producer once for concurrent identical keys', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    const gate = defer();

    const produce = () => {
      calls++;
      return gate.promise;
    };

    const a = flight.run('q1', produce);
    const b = flight.run('q1', produce);
    const c = flight.run('q1', produce);

    expect(calls).toBe(1);
    expect(flight.size).toBe(1);

    gate.resolve('payload');
    await expect(Promise.all([a, b, c])).resolves.toEqual(['payload', 'payload', 'payload']);
    expect(flight.size).toBe(0);
  });

  it('keeps different keys independent', async () => {
    const flight = new SingleFlight();
    const first = defer();
    const second = defer();
    let calls = 0;

    const a = flight.run('a', () => {
      calls++;
      return first.promise;
    });
    const b = flight.run('b', () => {
      calls++;
      return second.promise;
    });

    expect(calls).toBe(2);
    first.resolve('A');
    second.resolve('B');
    await expect(Promise.all([a, b])).resolves.toEqual(['A', 'B']);
  });

  it('clears the slot after a rejection so a retry can run', async () => {
    const flight = new SingleFlight();
    const failing = defer();

    const first = flight.run('q', () => failing.promise);
    failing.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    expect(flight.size).toBe(0);

    await expect(flight.run('q', async () => 'ok')).resolves.toBe('ok');
  });

  it('starts a fresh producer after completion', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    const produce = async () => {
      calls++;
      return calls;
    };
    expect(await flight.run('k', produce)).toBe(1);
    expect(await flight.run('k', produce)).toBe(2);
  });
});
