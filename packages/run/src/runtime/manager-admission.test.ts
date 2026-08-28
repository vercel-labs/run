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
