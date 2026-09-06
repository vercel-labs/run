import { describe, expect, it, vi } from 'vitest';
import { createRunner, getHostFunctionContext, run } from './index.js';
import { getRuntimeDiagnostics } from './runtime/manager.js';

describe.each(['function-body', 'module'] as const)(
  'suspending guest exception handlers (%s)',
  sourceType => {
    it.each([
      {
        name: 'catch with pending guest work',
        rounds: 1,
        source:
          'try { await tools.pause(); } catch { for (let i = 0; i < 100000; i++) {} }',
      },
      {
        name: 'finally with pending guest work',
        rounds: 1,
        source:
          'try { await tools.pause(); } finally { for (let i = 0; i < 100000; i++) {} }',
      },
      {
        name: 'nested catch across four interruptions',
        rounds: 4,
        source: `for (let i = 0; i < 4; i++) {
          try { await tools.pause(); }
          catch { try { await tools.pause(); } catch { continue; } }
        }`,
      },
      {
        name: 'Promise.catch callback',
        rounds: 1,
        source:
          'await tools.pause().catch(() => { for (let i = 0; i < 100000; i++) {} });',
      },
      {
        name: 'Promise.finally callback',
        rounds: 1,
        source:
          'await tools.pause().finally(() => { for (let i = 0; i < 100000; i++) {} });',
      },
      {
        name: 'finally inside an awaited async helper',
        rounds: 1,
        source: `async function helper() {
          try { await tools.pause(); }
          finally { for (let i = 0; i < 100000; i++) {} }
        }
        await helper();`,
      },
    ])(
      'returns a continuation before the timeout: $name',
      async ({ rounds: expectedRounds, source }) => {
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
        // The same source must complete normally; only host suspension changes.
        await expect(
          run({
            ...input,
            hostFunctions: {
              tools: { effect: () => 'created', pause: () => true },
            },
          }),
        ).resolves.toEqual({
          status: 'completed',
          value: sourceType === 'function-body' ? 42 : undefined,
        });
        let result = await run(input);
        let rounds = 0;
        while (result.status === 'interrupted') {
          expect(getRuntimeDiagnostics()).toMatchObject({
            activeInvocations: 0,
            idleWorkers: 1,
            terminatingWorkers: 0,
          });
          rounds += 1;
          expect(rounds).toBeLessThanOrEqual(expectedRounds);
          result = await run({
            ...input,
            continuation: result.continuation,
            resolutions: result.interruptions.map(interruption => ({
              interruptionId: interruption.id,
              value: true,
            })),
          });
        }
        expect(rounds).toBe(expectedRounds);
        expect(result).toEqual({
          status: 'completed',
          value: sourceType === 'function-body' ? 42 : undefined,
        });
        expect(effect).toHaveBeenCalledTimes(1);
        expect(pause).toHaveBeenCalledTimes(rounds * 2);
      },
    );

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

    it.each(['resolve', 'reject'])(
      'keeps catch and cleanup untouched until the host resumes with %s',
      async resolution => {
        const record = vi.fn();
        const pause = vi.fn(() => {
          const context = getHostFunctionContext();
          if (context.resume === undefined) {
            context.interrupt({ kind: 'pause' });
          }
          if (context.resume?.resolution === 'reject') {
            throw new Error('resumed host failure');
          }
          return 'resumed value';
        });
        const input = {
          hostFunctions: { tools: { pause, record } },
          limits: { timeoutMs: 1000 },
          source: `
            try { await tools.record(await tools.pause()); }
            catch (error) { await tools.record(error.message); }
            finally { await tools.record('cleanup'); }
          `,
          sourceType,
        };
        const interrupted = await run(input);
        expect(interrupted.status).toBe('interrupted');
        expect(record.mock.calls).toEqual([]);
        expect(pause).toHaveBeenCalledTimes(1);
        if (interrupted.status !== 'interrupted') {
          throw new Error(
            'Expected suspension before catch or finally executes.',
          );
        }
        expect(interrupted.interruptions).toHaveLength(1);
        const result = await run({
          ...input,
          continuation: interrupted.continuation,
          resolutions: interrupted.interruptions.map(item => ({
            interruptionId: item.id,
            value: resolution,
          })),
        });
        expect(result).toEqual({ status: 'completed', value: undefined });
        expect(record.mock.calls).toEqual([
          [resolution === 'reject' ? 'Host function failed.' : 'resumed value'],
          ['cleanup'],
        ]);
        expect(pause).toHaveBeenCalledTimes(2);
      },
    );

    it('can suspend again inside finally without repeating earlier cleanup', async () => {
      const record = vi.fn();
      const pause = vi.fn((phase: string) => {
        const context = getHostFunctionContext();
        if (context.resume === undefined) {
          context.interrupt({ phase });
        }
        return context.resume?.resolution;
      });
      const input = {
        hostFunctions: { tools: { pause, record } },
        limits: { timeoutMs: 1000 },
        source: `
          try { await tools.pause('work'); }
          finally {
            await tools.record('before-cleanup');
            await tools.pause('cleanup');
            await tools.record('after-cleanup');
          }
          await tools.record('done');
        `,
        sourceType,
      };
      let result = await run(input);
      for (const phase of ['work', 'cleanup']) {
        expect(result).toMatchObject({
          interruptions: [{ arguments: [phase], payload: { phase } }],
          status: 'interrupted',
        });
        expect(record.mock.calls).toEqual(
          phase === 'work' ? [] : [['before-cleanup']],
        );
        if (result.status !== 'interrupted') {
          throw new Error(`Expected suspension during ${phase}.`);
        }
        expect(result.interruptions).toHaveLength(1);
        result = await run({
          ...input,
          continuation: result.continuation,
          resolutions: result.interruptions.map(item => ({
            interruptionId: item.id,
            value: true,
          })),
        });
      }
      expect(result).toEqual({ status: 'completed', value: undefined });
      expect(record.mock.calls).toEqual([
        ['before-cleanup'],
        ['after-cleanup'],
        ['done'],
      ]);
      expect(pause.mock.calls).toEqual([
        ['work'],
        ['work'],
        ['cleanup'],
        ['cleanup'],
      ]);
    });

    it('resumes parallel interruptions by id and preserves settled outcomes in allSettled', async () => {
      const record = vi.fn();
      const ready = vi.fn(() => 'already completed');
      const fail = vi.fn(() => {
        throw new Error('already failed');
      });
      const pause = vi.fn((name: string) => {
        const context = getHostFunctionContext();
        if (context.resume === undefined) {
          context.interrupt({ name });
        }
        return context.resume?.resolution;
      });
      const input = {
        hostFunctions: { tools: { fail, pause, ready, record } },
        limits: { timeoutMs: 1000 },
        source: `
          try {
            const results = await Promise.allSettled([
              tools.ready(), tools.pause('alpha'), tools.fail(), tools.pause('beta'),
            ]);
            await tools.record(results.map(result => result.status === 'fulfilled'
              ? result.value : result.reason.message));
          } finally { await tools.record('cleanup'); }
        `,
        sourceType,
      };
      const interrupted = await run(input);
      expect(interrupted).toMatchObject({
        interruptions: [{ arguments: ['alpha'] }, { arguments: ['beta'] }],
        status: 'interrupted',
      });
      expect(record.mock.calls).toEqual([]);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(fail).toHaveBeenCalledTimes(1);
      if (interrupted.status !== 'interrupted') {
        throw new Error(
          'Expected both pending calls to interrupt the same invocation.',
        );
      }
      expect(interrupted.interruptions).toHaveLength(2);
      const result = await run({
        ...input,
        continuation: interrupted.continuation,
        resolutions: interrupted.interruptions.toReversed().map(item => ({
          interruptionId: item.id,
          value: `${item.arguments[0]} resolved`,
        })),
      });
      expect(result).toEqual({ status: 'completed', value: undefined });
      expect(record.mock.calls).toEqual([
        [
          [
            'already completed',
            'alpha resolved',
            'Host function failed.',
            'beta resolved',
          ],
        ],
        ['cleanup'],
      ]);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(pause.mock.calls).toEqual([
        ['alpha'],
        ['beta'],
        ['alpha'],
        ['beta'],
      ]);
    });

    it.each(['return', 'throw'])(
      'defers a finally %s override until after resume',
      async override => {
        const record = vi.fn();
        const input = {
          hostFunctions: {
            tools: {
              pause: () => {
                const context = getHostFunctionContext();
                if (context.resume === undefined) {
                  context.interrupt({ kind: 'pause' });
                }
                return context.resume?.resolution;
              },
              record,
            },
          },
          limits: { timeoutMs: 1000 },
          source: `
            async function task() {
              try { return await tools.pause(); }
              finally {
                await tools.record('cleanup');
                ${override === 'throw' ? "throw new Error('cleanup failure');" : "return 'cleanup value';"}
              }
            }
            await tools.record(await task());
          `,
          sourceType,
        };
        const interrupted = await run(input);
        expect(interrupted.status).toBe('interrupted');
        expect(record.mock.calls).toEqual([]);
        if (interrupted.status !== 'interrupted') {
          throw new Error('Expected suspension before the finally override.');
        }
        const resumed = run({
          ...input,
          continuation: interrupted.continuation,
          resolutions: interrupted.interruptions.map(item => ({
            interruptionId: item.id,
            value: 'original value',
          })),
        });
        if (override === 'throw') {
          await expect(resumed).rejects.toMatchObject({
            message: 'cleanup failure',
          });
          expect(record.mock.calls).toEqual([['cleanup']]);
        } else {
          await expect(resumed).resolves.toEqual({
            status: 'completed',
            value: undefined,
          });
          expect(record.mock.calls).toEqual([['cleanup'], ['cleanup value']]);
        }
      },
    );
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
