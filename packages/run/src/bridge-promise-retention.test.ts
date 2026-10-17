import { describe, expect, it } from 'vitest';
import { run } from './run.js';
import { RunHostFunctionError } from './errors.js';

describe('settled async host responses', () => {
  it.each(['resolve', 'reject'] as const)(
    'releases discarded payloads after %s',
    async outcome => {
      const payload = 'x'.repeat(outcome === 'reject' ? 16 * 1024 : 256 * 1024);
      const iterations = outcome === 'reject' ? 800 : 100;
      const result = await run({
        hostFunctions: {
          files: {
            read: () => {
              if (outcome === 'reject') {
                return Promise.reject(new RunHostFunctionError(payload));
              }
              return Promise.resolve(payload);
            },
          },
        },
        limits: {
          maxBridgeRequests: 1000,
          maxContinuationBytes: 64 * 1024 * 1024,
          memoryLimitBytes: 8 * 1024 * 1024,
          timeoutMs: 30_000,
        },
        source: `
          let total = 0;
          for (let i = 0; i < ${iterations}; i++) {
            try {
              total += (await files.read()).length;
            } catch (error) {
              total += error.message.length;
            }
          }
          return total;
        `,
      });
      expect(result).toEqual({
        status: 'completed',
        value: iterations * payload.length,
      });
    },
  );
});
