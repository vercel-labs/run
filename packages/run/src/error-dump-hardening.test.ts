import { Buffer } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './index.js';
import { setRuntimeWorkerFactoryForTest } from './runtime/manager.js';
import { INLINE_RUN_WORKER_SOURCE } from './runtime/worker-source.js';

function watchHostArrayGrowth(): () => number {
  const trips = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  // Exercise the actual worker and QuickJS dump, but stop a vulnerable host
  // array after 65,536 entries instead of allocating billions of elements.
  // This is test instrumentation, not the runtime's protection mechanism.
  const source = `
    import { workerData as dumpTestData } from 'node:worker_threads';
    {
      const trips = new Int32Array(dumpTestData);
      const push = Array.prototype.push;
      Array.prototype.push = function(...items) {
        if (this.length + items.length > 65_536) {
          Atomics.add(trips, 0, 1);
          throw new Error('Test watchdog: unbounded host array growth during error dump');
        }
        return Reflect.apply(push, this, items);
      };
    }
    ${INLINE_RUN_WORKER_SOURCE}
  `;
  setRuntimeWorkerFactoryForTest(() =>
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? new Worker(
          new URL(
            `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
          ),
          { execArgv: [], workerData: trips.buffer },
        )
      : new Worker(source, {
          eval: true,
          execArgv: [],
          workerData: trips.buffer,
        }),
  );
  return () => Atomics.load(trips, 0);
}

describe('guest error dump resource limits (VULN-17877)', () => {
  afterEach(() => {
    setRuntimeWorkerFactoryForTest(undefined);
  });

  it.each([
    ['a thrown sparse array', 'throw a;'],
    ['a rejected sparse array', 'return Promise.reject(a);'],
    ['a sparse array nested in a thrown object', 'throw { payload: a };'],
    ['a sparse array nested in a thrown array', 'throw [a];'],
    [
      'a sparse array returned by a getter',
      'throw { get payload() { return a; } };',
    ],
    ['a sparse array returned by toJSON', 'throw { toJSON() { return a; } };'],
    [
      'a sparse array in Error.code',
      "throw Object.assign(new Error('guest failure'), { code: a });",
    ],
    [
      'a sparse array in Error.details',
      "throw Object.assign(new Error('guest failure'), { details: a });",
    ],
    [
      'a sparse array nested in Error.code',
      "throw Object.assign(new Error('guest failure'), { code: { payload: a } });",
    ],
    [
      'a sparse array nested in Error.details',
      "throw Object.assign(new Error('guest failure'), { details: { payload: a } });",
    ],
  ])('bounds host allocations for %s', async (_name, statement) => {
    const watchdogTrips = watchHostArrayGrowth();
    const resultError = await run({
      limits: {
        memoryLimitBytes: 8 * 1024 * 1024,
        timeoutMs: 5000,
      },
      source: `const a = []; a.length = 4294967295; ${statement}`,
    }).catch((error: unknown) => error);

    expect(resultError).toBeInstanceOf(Error);
    // A timeout, worker crash, or swallowed watchdog exception is not a fix:
    // reject/truncate the guest error before building an oversized host array.
    expect(watchdogTrips()).toBe(0);
    expect(resultError).toMatchObject({ code: 'RUN_USER_SOURCE_ERROR' });
  });

  it('bounds host allocations for a sparse array thrown by a module', async () => {
    const watchdogTrips = watchHostArrayGrowth();
    await expect(
      run({
        limits: { memoryLimitBytes: 8 * 1024 * 1024, timeoutMs: 5000 },
        source: 'const a = []; a.length = 4294967295; throw a;',
        sourceType: 'module',
      }),
    ).rejects.toMatchObject({ code: 'RUN_USER_SOURCE_ERROR' });
    expect(watchdogTrips()).toBe(0);
  });

  it('preserves ordinary guest errors and their small details', async () => {
    const watchdogTrips = watchHostArrayGrowth();
    await expect(
      run({
        source: `
          throw Object.assign(new Error('guest failure'), {
            details: { values: [1, 2, 3] },
          });
        `,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      details: { values: [1, 2, 3] },
      message: 'guest failure',
    });
    expect(watchdogTrips()).toBe(0);
  });

  it('preserves shared references in ordinary error details', async () => {
    await expect(
      run({
        source: `
          const shared = { value: 1 };
          throw Object.assign(new Error('guest failure'), {
            details: { first: shared, second: shared },
          });
        `,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      details: { first: { value: 1 }, second: { value: 1 } },
      message: 'guest failure',
    });
  });

  it.each(['1n', "{ toJSON() { throw new Error('bad details'); } }"])(
    'preserves the error message when details cannot be serialized: %s',
    async details => {
      await expect(
        run({
          source: `throw Object.assign(new Error('guest failure'), { details: ${details} });`,
        }),
      ).rejects.toMatchObject({
        code: 'RUN_USER_SOURCE_ERROR',
        message: 'guest failure',
      });
    },
  );

  it.each([
    'const value = {}; value.self = value;',
    'let value = {}; for (let i = 0; i < 1000; i++) value = { nested: value };',
  ])('bounds cyclic or deeply nested details: %s', async setup => {
    await expect(
      run({
        source: `
          ${setup}
          throw Object.assign(new Error('guest failure'), { details: value });
        `,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      message: 'guest failure',
    });
  });

  it.each([
    "'x'.repeat(100_000)",
    "'é'.repeat(40_000)",
    String.raw`'\u0000'.repeat(20_000)`,
    'Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [i, i]))',
  ])(
    'handles oversized error payloads without losing worker capacity: %s',
    async payload => {
      await expect(
        run({ source: `throw { message: ${payload} };` }),
      ).rejects.toMatchObject({ code: 'RUN_USER_SOURCE_ERROR' });
      await expect(run({ source: 'return 42;' })).resolves.toEqual({
        status: 'completed',
        value: 42,
      });
    },
  );

  it('does not trip the watchdog for a sparse array kept inside the guest', async () => {
    const watchdogTrips = watchHostArrayGrowth();
    await expect(
      run({
        limits: { memoryLimitBytes: 8 * 1024 * 1024 },
        source: 'const a = []; a.length = 4294967295; return a.length;',
      }),
    ).resolves.toEqual({ status: 'completed', value: 4_294_967_295 });
    expect(watchdogTrips()).toBe(0);
  });
});
