import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RunSourceTooLargeError,
  getHostFunctionContext,
  run,
  setMaxWorkers,
} from '../index.js';
import { createPromiseWithResolvers } from '../utils/promise-with-resolvers.js';
import * as sourceCache from '../utils/source-cache.js';

const originalTransformSource = sourceCache.transformSource;

describe('run admission and source transformation', () => {
  const transformSourceSpy = vi.spyOn(sourceCache, 'transformSource');

  afterEach(() => {
    setMaxWorkers(undefined);
    transformSourceSpy.mockClear();
  });

  it('transforms sources above the cache entry limit only once', async () => {
    const source = `/* ${'x'.repeat(70_000)} */ return 1;`;

    await expect(run({ source })).resolves.toEqual({
      status: 'completed',
      value: 1,
    });
    expect(transformSourceSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an invocation at capacity before transforming its source', async () => {
    setMaxWorkers(1);
    const hostFunctionStarted = createPromiseWithResolvers<null>();
    const releaseHostFunction = createPromiseWithResolvers<null>();
    const activeRun = run({
      hostFunctions: {
        tools: {
          wait: async () => {
            hostFunctionStarted.resolve(null);
            await releaseHostFunction.promise;
          },
        },
      },
      source: 'return await tools.wait();',
    });

    try {
      await hostFunctionStarted.promise;
      transformSourceSpy.mockClear();

      await expect(
        run({ source: 'const value: number = 1; return value;' }),
      ).rejects.toMatchObject({ code: 'RUN_CONCURRENCY_LIMIT' });
      expect(transformSourceSpy).not.toHaveBeenCalled();
    } finally {
      releaseHostFunction.resolve(null);
      await activeRun;
    }
  });

  it('reserves memory capacity before a concurrent worker allocates', async () => {
    const estimatedWorkerBytes = (64 + 48) * 1024 * 1024;
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(estimatedWorkerBytes);
    const hostFunctionStarted = createPromiseWithResolvers<null>();
    const releaseHostFunction = createPromiseWithResolvers<null>();
    const activeRun = run({
      hostFunctions: {
        tools: {
          wait: async () => {
            hostFunctionStarted.resolve(null);
            await releaseHostFunction.promise;
          },
        },
      },
      source: 'return await tools.wait();',
    });

    try {
      await hostFunctionStarted.promise;

      await expect(run({ source: 'return 2;' })).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
      });
      releaseHostFunction.resolve(null);
      await activeRun;

      await expect(run({ source: 'return 3;' })).resolves.toEqual({
        status: 'completed',
        value: 3,
      });
    } finally {
      releaseHostFunction.resolve(null);
      await activeRun.catch(() => {});
      availableMemorySpy.mockRestore();
    }
  });

  const holdWorker = (
    input: {
      limits?: { memoryLimitBytes: number };
      reserveWorkers?: number;
    } = {},
  ) => {
    const hostFunctionStarted = createPromiseWithResolvers<null>();
    const releaseHostFunction = createPromiseWithResolvers<null>();
    const result = run({
      ...input,
      hostFunctions: {
        tools: {
          wait: async () => {
            hostFunctionStarted.resolve(null);
            await releaseHostFunction.promise;
          },
        },
      },
      source: 'return await tools.wait();',
    });
    return {
      release: async () => {
        releaseHostFunction.resolve(null);
        await result.catch(() => {});
      },
      result,
      started: Promise.race([
        hostFunctionStarted.promise,
        result.then(() => {
          throw new Error('Held invocation settled before it started.');
        }),
      ]),
    };
  };

  it('refuses an invocation that would leave fewer free workers than it reserves', async () => {
    setMaxWorkers(2);
    const held = holdWorker({ reserveWorkers: 1 });

    try {
      await held.started;

      await expect(
        run({ reserveWorkers: 1, source: 'return 1;' }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 2, reserveWorkers: 1 },
        message:
          'JavaScript runtime refused the invocation to keep 1 reserved worker free (maxWorkers 2).',
      });
      await expect(run({ source: 'return 2;' })).resolves.toEqual({
        status: 'completed',
        value: 2,
      });
    } finally {
      await held.release();
    }
    await expect(held.result).resolves.toEqual({
      status: 'completed',
      value: undefined,
    });
  });

  it('reports a full worker cap without the reserve', async () => {
    setMaxWorkers(2);
    const held = [holdWorker(), holdWorker()];

    try {
      await Promise.all(held.map(worker => worker.started));

      await expect(
        run({ reserveWorkers: 1, source: 'return 1;' }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 2 },
        message: 'JavaScript runtime maxWorkers limit reached (2).',
      });
    } finally {
      await Promise.all(held.map(worker => worker.release()));
    }
  });

  it('always refuses a reserving invocation under a cap of 1', async () => {
    setMaxWorkers(1);

    await expect(
      run({ reserveWorkers: 1, source: 'return 1;' }),
    ).rejects.toMatchObject({ code: 'RUN_CONCURRENCY_LIMIT' });
    await expect(run({ source: 'return 2;' })).resolves.toEqual({
      status: 'completed',
      value: 2,
    });
  });

  it('admits each continuation resume with its own reserveWorkers', async () => {
    setMaxWorkers(2);
    const source = 'return await tools.approve();';
    const hostFunctions = {
      tools: {
        approve: () => {
          const context = getHostFunctionContext();
          if (context.resume === undefined) {
            context.interrupt({ kind: 'approval' });
          }
          return context.resume?.resolution;
        },
      },
    };
    const interrupted = await run({
      hostFunctions,
      reserveWorkers: 1,
      source,
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    const resume = (reserveWorkers: number) =>
      run({
        continuation: interrupted.continuation,
        hostFunctions,
        reserveWorkers,
        resolutions: [
          {
            interruptionId: interrupted.interruptions[0]?.id ?? '',
            value: true,
          },
        ],
        source,
      });
    setMaxWorkers(1);

    await expect(resume(1)).rejects.toMatchObject({
      code: 'RUN_CONCURRENCY_LIMIT',
      details: { maxWorkers: 1, reserveWorkers: 1 },
    });
    await expect(resume(0)).resolves.toEqual({
      status: 'completed',
      value: true,
    });
  });

  it('keeps reserved workers within the memory budget', async () => {
    const mib = 1024 * 1024;
    // Worker estimates: 176 MiB for the 128 MiB holder, 64 MiB for 16 MiB.
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(300 * mib);
    const held = holdWorker({ limits: { memoryLimitBytes: 128 * mib } });
    const limits = { memoryLimitBytes: 16 * mib };

    try {
      await held.started;

      await expect(
        run({ limits, reserveWorkers: 1, source: 'return 1;' }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 1, reserveWorkers: 1 },
      });
      await expect(run({ limits, source: 'return 2;' })).resolves.toEqual({
        status: 'completed',
        value: 2,
      });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
  });

  it('reports an exhausted memory budget without the reserve', async () => {
    const mib = 1024 * 1024;
    // Worker estimates: 256 MiB for the 208 MiB holder, 64 MiB for 16 MiB.
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(300 * mib);
    const held = holdWorker({ limits: { memoryLimitBytes: 208 * mib } });

    try {
      await held.started;

      await expect(
        run({
          limits: { memoryLimitBytes: 16 * mib },
          reserveWorkers: 1,
          source: 'return 1;',
        }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 1 },
        message: 'JavaScript runtime maxWorkers limit reached (1).',
      });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
  });

  it('reports an exhausted memory budget when the reserve also exceeds the cap', async () => {
    const mib = 1024 * 1024;
    // Worker estimates: 256 MiB for the 208 MiB holder, 112 MiB for 64 MiB,
    // so the dynamic cap for the second invocation is 2.
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(300 * mib);
    const held = holdWorker({ limits: { memoryLimitBytes: 208 * mib } });

    try {
      await held.started;

      await expect(
        run({
          limits: { memoryLimitBytes: 64 * mib },
          reserveWorkers: 1,
          source: 'return 1;',
        }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 1 },
        message: 'JavaScript runtime maxWorkers limit reached (1).',
      });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
  });

  it('counts a reserving worker once against the memory budget', async () => {
    const mib = 1024 * 1024;
    const limits = { memoryLimitBytes: 256 * mib };
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(768 * mib);
    const held = holdWorker({ limits, reserveWorkers: 1 });

    try {
      await held.started;
      availableMemorySpy.mockReturnValue(384 * mib);

      await expect(run({ limits, source: 'return 2;' })).resolves.toEqual({
        status: 'completed',
        value: 2,
      });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
    await expect(held.result).resolves.toEqual({
      status: 'completed',
      value: undefined,
    });
  });

  it('refuses a plain invocation the memory left beside a reserving one cannot fit', async () => {
    const mib = 1024 * 1024;
    const limits = { memoryLimitBytes: 256 * mib };
    // Async host functions need no synchronous bridge buffer.
    const workerBytes = (256 + 48) * mib;
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(768 * mib);
    const held = holdWorker({ limits, reserveWorkers: 1 });

    try {
      await held.started;
      availableMemorySpy.mockReturnValue(workerBytes);
      await expect(run({ limits, source: 'return 1;' })).resolves.toEqual({
        status: 'completed',
        value: 1,
      });

      availableMemorySpy.mockReturnValue(workerBytes - 1);

      await expect(run({ limits, source: 'return 2;' })).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 1 },
        message: 'JavaScript runtime maxWorkers limit reached (1).',
      });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
  });

  it('counts workers admitted beside a reserving one before they allocate', async () => {
    const mib = 1024 * 1024;
    const limits = { memoryLimitBytes: 16 * mib };
    // Worker estimate: 64 MiB.
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(256 * mib);
    const held = holdWorker({ limits, reserveWorkers: 1 });

    try {
      await held.started;
      availableMemorySpy.mockReturnValue(64 * mib);

      const [first, second] = await Promise.allSettled([
        run({ limits, source: 'return 1;' }),
        run({ limits, source: 'return 2;' }),
      ]);
      expect(first).toEqual({
        status: 'fulfilled',
        value: { status: 'completed', value: 1 },
      });
      expect(second).toMatchObject({
        reason: {
          code: 'RUN_CONCURRENCY_LIMIT',
          message: 'JavaScript runtime maxWorkers limit reached (2).',
        },
        status: 'rejected',
      });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
  });

  it('reports the held reserve that refuses a reserving invocation', async () => {
    const mib = 1024 * 1024;
    const limits = { memoryLimitBytes: 16 * mib };
    // Worker estimate: 64 MiB. Beside the holder, 176 MiB fit a reserver that
    // keeps one worker free, not the two the holder keeps free.
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(240 * mib);
    const held = holdWorker({ limits, reserveWorkers: 2 });

    try {
      await held.started;

      await expect(
        run({ limits, reserveWorkers: 1, source: 'return 1;' }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 3, reserveWorkers: 2 },
        message:
          'JavaScript runtime refused the invocation to keep 2 reserved workers free (maxWorkers 3).',
      });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
  });

  it('holds the remaining reserve once the larger reserving invocation ends', async () => {
    const mib = 1024 * 1024;
    const small = { memoryLimitBytes: 16 * mib };
    // Worker estimates: 64 MiB for 16 MiB, 112 MiB for 64 MiB.
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(320 * mib);
    const smallReserver = holdWorker({ limits: small, reserveWorkers: 1 });
    const held = [smallReserver];

    try {
      await smallReserver.started;
      const largeReserver = holdWorker({
        limits: { memoryLimitBytes: 64 * mib },
        reserveWorkers: 1,
      });
      held.push(largeReserver);
      await largeReserver.started;
      for (const _ of [1, 2]) {
        const plain = holdWorker({ limits: small });
        held.push(plain);
        await plain.started;
      }

      await expect(
        run({ limits: small, reserveWorkers: 1, source: 'return 1;' }),
      ).rejects.toMatchObject({ code: 'RUN_CONCURRENCY_LIMIT' });

      // 128 MiB remain: room for a small reserver keeping a small worker free,
      // not one keeping the larger reserver's 112 MiB free.
      await largeReserver.release();
      await expect(
        run({ limits: small, reserveWorkers: 1, source: 'return 2;' }),
      ).resolves.toEqual({ status: 'completed', value: 2 });
    } finally {
      await Promise.all(held.map(worker => worker.release()));
      availableMemorySpy.mockRestore();
    }
  });

  it('returns the memory reservation of an invocation refused for its reserve', async () => {
    const mib = 1024 * 1024;
    // Worker estimates: 64 MiB for the 16 MiB holder, 112 MiB for 64 MiB, so
    // the reserve call fits the 300 MiB budget but exceeds the dynamic cap of 2.
    const availableMemorySpy = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(300 * mib);
    const held = holdWorker({ limits: { memoryLimitBytes: 16 * mib } });

    try {
      await held.started;
      await expect(
        run({
          limits: { memoryLimitBytes: 64 * mib },
          reserveWorkers: 1,
          source: 'return 1;',
        }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: { maxWorkers: 2, reserveWorkers: 1 },
      });
      await expect(
        run({
          limits: { memoryLimitBytes: 16 * mib },
          reserveWorkers: 1,
          source: 'return 3;',
        }),
      ).resolves.toEqual({ status: 'completed', value: 3 });
      await held.release();

      availableMemorySpy.mockReturnValue(1000 * mib);
      await expect(
        run({ limits: { memoryLimitBytes: 300 * mib }, source: 'return 2;' }),
      ).resolves.toEqual({ status: 'completed', value: 2 });
    } finally {
      await held.release();
      availableMemorySpy.mockRestore();
    }
  });

  it('compares reserveWorkers against free workers without rounding', async () => {
    setMaxWorkers(2 ** 53);
    const held = holdWorker();

    try {
      await held.started;

      await expect(
        run({ reserveWorkers: Number.MAX_SAFE_INTEGER, source: 'return 1;' }),
      ).rejects.toMatchObject({
        code: 'RUN_CONCURRENCY_LIMIT',
        details: {
          maxWorkers: 2 ** 53,
          reserveWorkers: Number.MAX_SAFE_INTEGER,
        },
      });
    } finally {
      await held.release();
    }
  });

  it('uses reserveWorkers as read once from the input', async () => {
    setMaxWorkers(1);
    let reads = 0;
    const input = { source: 'return 1;' };
    Object.defineProperty(input, 'reserveWorkers', {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) {
          throw new Error('reserveWorkers read twice.');
        }
        return 1;
      },
    });

    await expect(run(input)).rejects.toMatchObject({
      code: 'RUN_CONCURRENCY_LIMIT',
      details: { reserveWorkers: 1 },
    });
  });

  it('invokes input getters on the input itself', async () => {
    class Input {
      declare readonly source: string;
      readonly #source = 'return 1;';

      constructor() {
        Object.defineProperty(this, 'source', {
          enumerable: true,
          get(this: Input) {
            return this.#source;
          },
        });
      }
    }

    await expect(run(new Input())).resolves.toEqual({
      status: 'completed',
      value: 1,
    });
  });

  it('honors an inherited reserveWorkers', async () => {
    setMaxWorkers(1);
    const input = Object.assign(Object.create({ reserveWorkers: 1 }), {
      source: 'return 1;',
    });

    await expect(run(input)).rejects.toMatchObject({
      code: 'RUN_CONCURRENCY_LIMIT',
      details: { reserveWorkers: 1 },
    });
  });

  it.each([-1, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, '1'])(
    'rejects invalid reserveWorkers %s',
    async value => {
      await expect(
        run({ reserveWorkers: value as number, source: 'return 1;' }),
      ).rejects.toThrow(
        new TypeError('reserveWorkers must be a non-negative integer.'),
      );
    },
  );

  it('releases the admission slot when source transformation fails', async () => {
    setMaxWorkers(1);
    transformSourceSpy.mockImplementationOnce(() => {
      throw new Error('transform failed');
    });

    await expect(run({ source: 'return 1;' })).rejects.toThrow(
      'transform failed',
    );
    await expect(run({ source: 'return 2;' })).resolves.toEqual({
      status: 'completed',
      value: 2,
    });
  });

  it('rejects transformed entry source above the configured limit', async () => {
    transformSourceSpy.mockImplementationOnce(() => 'x'.repeat(65));

    await expect(
      run({
        limits: { maxSourceBytes: 64 },
        moduleLoader: { load: () => 'export {};' },
        source: 'export {};',
      }),
    ).rejects.toBeInstanceOf(RunSourceTooLargeError);
  });

  it('resumes when TypeScript transform output changes between hosts', async () => {
    const source =
      'const approved: boolean = await tools.approve(); return approved;';
    const hostFunctions = {
      tools: {
        approve: () => {
          const context = getHostFunctionContext();
          if (context.resume === undefined) {
            context.interrupt({ kind: 'approval' });
          }
          return context.resume?.resolution;
        },
      },
    };
    const interrupted = await run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }

    transformSourceSpy.mockImplementationOnce(
      value => `${originalTransformSource(value)}\n`,
    );

    await expect(
      run({
        continuation: interrupted.continuation,
        hostFunctions,
        resolutions: [
          {
            interruptionId: interrupted.interruptions[0]?.id ?? '',
            value: true,
          },
        ],
        source,
      }),
    ).resolves.toEqual({ status: 'completed', value: true });
  });
});
