import { Buffer } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunner, run } from './index.js';
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
      'a callable with sparse diagnostic properties',
      'throw Object.assign(() => {}, { details: a });',
    ],
    [
      'a callable proxy exposing a sparse array',
      'throw new Proxy(() => {}, { get() { return a; } });',
    ],
    [
      'a callable with a sparse toJSON result',
      'throw Object.assign(() => {}, { toJSON() { return a; } });',
    ],
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

  it.each([
    ['undefined', 'undefined'],
    ['null', 'null'],
    ['true', 'true'],
    ['42', '42'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ["'guest failure'", 'guest failure'],
    ['123n', '123'],
    ['1n << 80n', '1208925819614629174706176'],
    ["Symbol('local')", 'undefined'],
    ["Symbol.for('global')", 'Symbol(global)'],
    ['(() => {})', 'undefined'],
  ])('preserves the bounded message for thrown %s', async (value, message) => {
    await expect(run({ source: `throw (${value});` })).rejects.toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      message,
    });
  });

  it.each(['1n << 1_000_000n', '-(1n << 1_000_000n)'])(
    'bounds a large BigInt before decimal conversion: %s',
    async value => {
      // A small guest allocation exercises the same conversion path as the
      // reported 200-million-bit value without stressing the test process.
      await expect(
        run({
          limits: { memoryLimitBytes: 8 * 1024 * 1024, timeoutMs: 5000 },
          source: `throw (${value});`,
        }),
      ).rejects.toMatchObject({
        code: 'RUN_USER_SOURCE_ERROR',
        message: '[Truncated]',
      });
    },
  );

  it.each([
    "'x'.repeat(100_000)",
    "'é'.repeat(50_000)",
    "'🧪'.repeat(50_000)",
    String.raw`'\u0000'.repeat(100_000)`,
    'String.fromCharCode(34, 92).repeat(50_000)',
    'String.fromCharCode(0xD800).repeat(100_000)',
  ])(
    'truncates oversized Error messages without losing their identity: %s',
    async payload => {
      const resultError = await run({
        source: `
        function fail() {
          throw new TypeError('original failure: ' + ${payload});
        }
        fail();
      `,
      }).catch((error: unknown) => error);

      expect(resultError).toMatchObject({
        code: 'RUN_USER_SOURCE_ERROR',
        message: expect.stringMatching(
          /^original failure: .*…\[truncated\]$/su,
        ),
        name: 'TypeError',
        stack: expect.stringContaining('at fail (run.js:'),
      });
      expect(
        Buffer.byteLength((resultError as Error).message),
      ).toBeLessThanOrEqual(16 * 1024);
    },
  );

  it('truncates an oversized Error stack without losing its message or frames', async () => {
    const resultError = await run({
      source: `
        const error = new TypeError('original failure');
        error.stack = '    at repeated (other.js:1:1)\\n'.repeat(10_000);
        throw error;
      `,
    }).catch((error: unknown) => error);

    expect(resultError).toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      message: 'original failure',
      name: 'TypeError',
      stack: expect.stringContaining('at repeated (other.js:1:1)'),
    });
    expect(
      Buffer.byteLength((resultError as Error).stack ?? ''),
    ).toBeLessThanOrEqual(32 * 1024);
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

  it.each([
    "{ message: 'original failure', details: 'x'.repeat(70_000) }",
    "{ message: 'original failure', details: 'é'.repeat(40_000) }",
    "{ message: 'original failure', count: 1n }",
    "{ message: 'original failure', get extra() { throw 1; } }",
    "{ message: 'original failure', details: { get extra() { throw 1; } } }",
  ])(
    'preserves the message of an error-like object with unusable diagnostics: %s',
    async value => {
      await expect(run({ source: `throw (${value});` })).rejects.toMatchObject({
        code: 'RUN_USER_SOURCE_ERROR',
        message: 'original failure',
      });
    },
  );

  it('truncates an oversized message on an error-like object', async () => {
    const resultError = await run({
      source: "throw { message: 'original failure: ' + 'x'.repeat(70_000) };",
    }).catch((error: unknown) => error);

    expect(resultError).toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      message: expect.stringMatching(/^original failure: .*…\[truncated\]$/u),
    });
    expect(
      Buffer.byteLength((resultError as Error).message),
    ).toBeLessThanOrEqual(16 * 1024);
  });

  it.each([
    ['Error', 'new Error()', "'x'.repeat(70_000)"],
    ['Error', 'new Error()', "'é'.repeat(40_000)"],
    ['Error', 'new Error()', '1n'],
    ['error-like object', '{}', "'x'.repeat(70_000)"],
    ['error-like object', '{}', "'é'.repeat(40_000)"],
    ['error-like object', '{}', '1n'],
  ])(
    'reads %s core accessors once when diagnostics cannot be serialized: %s %s',
    async (_name, value, details) => {
      const calls: string[] = [];
      const runner = createRunner({
        syncHostFunctions: {
          tools: {
            read(property: string) {
              calls.push(property);
              if (property === 'name') {
                return 'ValidationError';
              }
              if (property === 'message') {
                return 'original failure';
              }
              return '    at captured (other.js:1:1)';
            },
          },
        },
      });

      await expect(
        runner.run({
          source: `
          const error = ${value};
          for (const property of ['name', 'message', 'stack']) {
            Object.defineProperty(error, property, { get() { return tools.read(property); } });
          }
          error.details = ${details};
          throw error;
        `,
        }),
      ).rejects.toMatchObject({
        code: 'RUN_USER_SOURCE_ERROR',
        message: 'original failure',
        name: 'ValidationError',
        stack: expect.stringContaining('at captured (other.js:1:1)'),
      });
      expect(calls).toEqual(['name', 'message', 'stack']);
    },
  );

  it('uses captured core fields if diagnostic serialization mutates the thrown error', async () => {
    await expect(
      run({
        source: `
          const error = new Error('original failure');
          error.details = { toJSON() { error.message = 'changed'; return 'x'.repeat(70_000); } };
          throw error;
        `,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      message: 'original failure',
    });
  });

  it('preserves a small diagnostic getter on an error-like object', async () => {
    await expect(
      run({
        source:
          "throw { message: 'original failure', get details() { return { count: 1 }; } };",
      }),
    ).rejects.toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
      details: { count: 1 },
      message: 'original failure',
    });
  });

  it.each([
    ['details', "'x'.repeat(70_000)"],
    ['details', "'é'.repeat(40_000)"],
    ['details', String.raw`'\u0000'.repeat(20_000)`],
    ['code', "'x'.repeat(70_000)"],
    ['code', "'é'.repeat(40_000)"],
    ['code', String.raw`'\u0000'.repeat(20_000)`],
  ])(
    'preserves the original error when %s exceeds the serialized-size limit: %s',
    async (property, payload) => {
      const resultError = await run({
        source: `
          function fail() {
            const error = new TypeError('original failure');
            error.${property} = ${payload};
            throw error;
          }
          fail();
        `,
      }).catch((error: unknown) => error);

      expect(resultError).toMatchObject({
        code: 'RUN_USER_SOURCE_ERROR',
        details: undefined,
        message: 'original failure',
        name: 'TypeError',
        stack: expect.stringContaining('at fail (run.js:'),
      });
    },
  );

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
