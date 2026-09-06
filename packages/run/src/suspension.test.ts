import { describe, expect, it, vi } from 'vitest';
import { createRunner, getHostFunctionContext, run } from './index.js';
import { getRuntimeDiagnostics } from './runtime/manager.js';

describe.each(['function-body', 'module'] as const)(
  'suspending guest exception handlers (%s)',
  sourceType => {
    it.each([
      'try { await tools.pause(); } catch { for (let i = 0; i < 100000; i++) {} }',
      'try { await tools.pause(); } finally { for (let i = 0; i < 100000; i++) {} }',
      `for (let i = 0; i < 4; i++) {
      try { await tools.pause(); }
      catch { try { await tools.pause(); } catch { continue; } }
    }`,
    ])('returns a continuation and resumes %s', async source => {
      const effect = vi.fn(() => 'created');
      const pause = vi.fn(() => {
        const context = getHostFunctionContext();
        if (context.resume === undefined) {
          context.interrupt({ kind: 'pause' });
        }
        return context.resume?.resolution;
      });
      const input = {
        hostFunctions: { tools: { effect, pause } },
        limits: { timeoutMs: 1000 },
        source: `await tools.effect(); ${source}; ${sourceType === 'function-body' ? 'return 42;' : ''}`,
        sourceType,
      };
      let result = await run(input);
      let rounds = 0;
      while (result.status === 'interrupted') {
        expect(getRuntimeDiagnostics()).toMatchObject({
          activeInvocations: 0,
          idleWorkers: 1,
          terminatingWorkers: 0,
        });
        rounds += 1;
        expect(rounds).toBeLessThanOrEqual(4);
        result = await run({
          ...input,
          continuation: result.continuation,
          resolutions: result.interruptions.map(interruption => ({
            interruptionId: interruption.id,
            value: true,
          })),
        });
      }
      expect(rounds).toBeGreaterThan(0);
      expect(result).toEqual({
        status: 'completed',
        value: sourceType === 'function-body' ? 42 : undefined,
      });
      expect(effect).toHaveBeenCalledTimes(1);
      expect(pause).toHaveBeenCalledTimes(rounds * 2);
    });

    it('runs finally host effects only after resuming the interrupted call', async () => {
      const cleanup = vi.fn(() => 'cleaned');
      const input = {
        hostFunctions: {
          tools: {
            cleanup,
            pause: () => {
              const context = getHostFunctionContext();
              if (context.resume === undefined) {
                context.interrupt({ kind: 'pause' });
              }
              return context.resume?.resolution;
            },
          },
        },
        source: `try { ${sourceType === 'function-body' ? 'return ' : ''}await tools.pause(); } finally { await tools.cleanup(); }`,
        sourceType,
      };
      const interrupted = await run(input);
      expect(interrupted.status).toBe('interrupted');
      expect(cleanup).not.toHaveBeenCalled();
      if (interrupted.status !== 'interrupted') {
        throw new Error('Expected an interruption.');
      }
      await expect(
        run({
          ...input,
          continuation: interrupted.continuation,
          resolutions: interrupted.interruptions.map(interruption => ({
            interruptionId: interruption.id,
            value: 42,
          })),
        }),
      ).resolves.toEqual({
        status: 'completed',
        value: sourceType === 'function-body' ? 42 : undefined,
      });
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  },
);

describe('resuming repeated host calls', () => {
  it.each([
    'for (let i = 0; i < 40; i++) { await tools.alpha({ i }); } return 40;',
    'const a = []; for (let i = 0; i < 40; i++) { a.push(await tools.alpha({ i })); } return a.length;',
  ])('completes 40 resumptions: %s', async source => {
    const alpha = vi.fn(() => {
      const context = getHostFunctionContext();
      if (context.resume === undefined) {
        context.interrupt({});
      }
      return context.resume?.resolution;
    });
    const input = {
      hostFunctions: { tools: { alpha } },
      limits: { timeoutMs: 1000 },
      source,
    };
    let resumeInput = {};
    for (let round = 1; round <= 41; round += 1) {
      const runner = createRunner({ continuationSecret: 'x'.repeat(48) });
      const result = await runner.run({ ...input, ...resumeInput });
      if (result.status === 'completed') {
        expect(round).toBe(41);
        expect(result.value).toBe(40);
        expect(alpha).toHaveBeenCalledTimes(80);
        return;
      }
      resumeInput = {
        continuation: result.continuation,
        resolutions: result.interruptions.map(interruption => ({
          interruptionId: interruption.id,
          value: 1,
        })),
      };
    }
    throw new Error('Expected completion after 40 resumptions.');
  });
});

describe('guest source error provenance', () => {
  it.each([
    'return (;',
    "throw new Error('guest failure');",
    "throw 'guest primitive';",
    "throw Object.assign(new Error('guest failure'), { code: 'RUN_PROTOCOL_ERROR' });",
  ])('marks a guest failure without trusting its code: %s', async source => {
    await expect(run({ source })).rejects.toMatchObject({
      code: 'RUN_USER_SOURCE_ERROR',
    });
  });

  it('preserves an actual host failure and a real CPU timeout', async () => {
    await expect(
      run({
        hostFunctions: {
          tools: {
            fail: () => {
              throw new Error('host failure');
            },
          },
        },
        source: 'return await tools.fail();',
      }),
    ).rejects.toMatchObject({ code: 'RUN_HOST_FUNCTION_ERROR' });
    await expect(
      run({
        limits: { timeoutMs: 100 },
        source: 'while (true) {}',
      }),
    ).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
    await expect(run({ source: 'return 42;' })).resolves.toMatchObject({
      status: 'completed',
      value: 42,
    });
  });
});
