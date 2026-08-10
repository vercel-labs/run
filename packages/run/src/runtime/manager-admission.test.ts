import { afterEach, describe, expect, it, vi } from 'vitest';
import { run, setMaxWorkers } from '../index.js';
import { createPromiseWithResolvers } from '../utils/promise-with-resolvers.js';
import * as sourceCache from '../utils/source-cache.js';

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
    const bindingStarted = createPromiseWithResolvers<null>();
    const releaseBinding = createPromiseWithResolvers<null>();
    const activeRun = run({
      bindings: {
        tools: {
          wait: async () => {
            bindingStarted.resolve(null);
            await releaseBinding.promise;
          },
        },
      },
      source: 'return await tools.wait();',
    });

    try {
      await bindingStarted.promise;
      transformSourceSpy.mockClear();

      await expect(
        run({ source: 'const value: number = 1; return value;' }),
      ).rejects.toMatchObject({ code: 'RUN_CONCURRENCY_LIMIT' });
      expect(transformSourceSpy).not.toHaveBeenCalled();
    } finally {
      releaseBinding.resolve(null);
      await activeRun;
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
});
