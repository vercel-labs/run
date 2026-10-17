import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHostFunctionError, createRunner } from './index.js';

describe('asynchronous replay history', () => {
  const previousSecret = process.env.RUN_CONTINUATION_SECRET;

  beforeEach(() => {
    delete process.env.RUN_CONTINUATION_SECRET;
  });

  afterEach(() => {
    if (previousSecret !== undefined) {
      process.env.RUN_CONTINUATION_SECRET = previousSecret;
    }
  });

  const cases = [
    {
      call: (value: string) => value,
      name: 'fulfilled calls',
      source: `
        let total = 0;
        for (let i = 0; i < 8; i++) {
          total += (await tools.call('x'.repeat(1024))).length;
        }
        return total;
      `,
    },
    {
      call: (value: string) => {
        throw new RunHostFunctionError(value);
      },
      name: 'caught rejections',
      source: `
        let total = 0;
        for (let i = 0; i < 8; i++) {
          try {
            await tools.call('x'.repeat(1024));
          } catch (error) {
            total += error.message.length;
          }
        }
        return total;
      `,
    },
  ];

  it.each(cases)(
    'does not accumulate $name without continuations',
    async ({ call, source }) => {
      const runner = createRunner();

      await expect(
        runner.run({
          hostFunctions: { tools: { call } },
          limits: { maxContinuationBytes: 4096 },
          source,
        }),
      ).resolves.toEqual({ status: 'completed', value: 8192 });
    },
  );

  it.each(cases)(
    'still bounds $name when continuations are enabled',
    async ({ call, source }) => {
      const runner = createRunner({ continuationSecret: 'x'.repeat(32) });

      await expect(
        runner.run({
          hostFunctions: { tools: { call } },
          limits: { maxContinuationBytes: 4096 },
          source,
        }),
      ).rejects.toMatchObject({
        code: 'RUN_PROTOCOL_ERROR',
        message: 'Continuation state exceeds the 4096 byte size limit.',
      });
    },
  );
});
