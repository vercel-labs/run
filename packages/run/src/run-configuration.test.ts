import { describe, expect, it } from 'vitest';
import { getBindingContext, run } from './index.js';

describe('run configuration', () => {
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
          bindings: {
            tools: {
              pause: () => getBindingContext().interrupt({ kind: 'pause' }),
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
