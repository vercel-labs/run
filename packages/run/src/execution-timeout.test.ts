import { describe, expect, it } from 'vitest';
import { run } from './index.js';

describe('execution timeout', () => {
  it('lets JavaScript work continue until timeoutMs', async () => {
    let calls = 0;
    const result = await run({
      hostFunctions: {
        host: {
          send: () => {
            calls += 1;
            return true;
          },
        },
      },
      limits: { maxBridgeRequests: 5000, timeoutMs: 60_000 },
      source: `
        const text = 'x'.repeat(3000);
        for (let i = 0; i < 3000; i++) await host.send({ i, text });
        return 'done';
      `,
    });

    expect(result).toEqual({ status: 'completed', value: 'done' });
    expect(calls).toBe(3000);
  }, 90_000);

  it('reports RUN_TIMEOUT when the deadline passes after an await', async () => {
    await expect(
      run({
        hostFunctions: { host: { ping: () => true } },
        limits: { timeoutMs: 200 },
        source: 'await host.ping(); while (true) {}',
      }),
    ).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
  }, 10_000);
});
