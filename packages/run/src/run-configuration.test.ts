import { describe, expect, it } from 'vitest';
import { getHostFunctionContext, run } from './index.js';

describe('run configuration', () => {
  it('rejects an invalid source type', async () => {
    await expect(
      run({ source: 'return 1;', sourceType: 'script' as never }),
    ).rejects.toThrow('Invalid sourceType configuration.');
  });

  it('observes a continuation secret configured after first use', async () => {
    const previous = process.env.RUN_CONTINUATION_SECRET;
    delete process.env.RUN_CONTINUATION_SECRET;

    try {
      await expect(run({ source: 'return 1;' })).resolves.toEqual({
        status: 'completed',
        value: 1,
      });

      process.env.RUN_CONTINUATION_SECRET = 'late-continuation-secret-32-bytes';

      await expect(
        run({
          hostFunctions: {
            tools: {
              pause: () =>
                getHostFunctionContext().interrupt({ kind: 'pause' }),
            },
          },
          source: 'return await tools.pause();',
        }),
      ).resolves.toMatchObject({ status: 'interrupted' });
    } finally {
      if (previous === undefined) {
        delete process.env.RUN_CONTINUATION_SECRET;
      } else {
        process.env.RUN_CONTINUATION_SECRET = previous;
      }
    }
  });
});
