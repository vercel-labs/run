import { describe, expect, it, vi } from 'vitest';
import { createRunner, getHostFunctionContext, run } from './index.js';
import type { RunContinuationState, RunInterruptedResult } from './index.js';
import { createPromiseWithResolvers } from './utils/promise-with-resolvers.js';

const firstInterruptionId = (result: RunInterruptedResult): string => {
  const interruption = result.interruptions.at(0);
  if (interruption === undefined) {
    throw new Error('Expected an interruption.');
  }
  return interruption.id;
};

const createPrng = (initialState: number): (() => number) => {
  let state = initialState;
  return () => {
    const signedState = Math.imul(1_664_525, state) + 1_013_904_223;
    state = signedState < 0 ? signedState + 2 ** 32 : signedState;
    return state;
  };
};

describe('continuation replay hardening', () => {
  it('preserves a long time/random trace across multiple interruption rounds', async () => {
    const traces: unknown[] = [];
    const source = `
      const trace = [];
      for (let i = 0; i < 64; i++) trace.push([Date.now(), Math.random()]);
      await tools.record(trace);
      const first = await tools.pause({ round: 1 });
      for (let i = 0; i < 64; i++) trace.push([Date.now(), Math.random()]);
      await tools.record(trace);
      const second = await tools.pause({ round: 2 });
      return { trace, first, second };
    `;
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'pause' });
          }
          return context.resume?.resolution;
        },
        record: (trace: unknown) => traces.push(trace),
      },
    };

    const first = await run({ hostFunctions, source });
    if (first.status !== 'interrupted') {
      throw new Error('Expected round one.');
    }
    const second = await run({
      hostFunctions,
      continuation: first.continuation,
      resolutions: [
        { interruptionId: firstInterruptionId(first), value: 'one' },
      ],
      source,
    });
    if (second.status !== 'interrupted') {
      throw new Error('Expected round two.');
    }
    const completed = await run({
      hostFunctions,
      continuation: second.continuation,
      resolutions: [
        { interruptionId: firstInterruptionId(second), value: 'two' },
      ],
      source,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      value: { first: 'one', second: 'two' },
    });
    expect(traces).toHaveLength(2);
    if (completed.status === 'completed') {
      expect((completed.value as { trace: unknown }).trace).toEqual(traces[1]);
      expect((traces[1] as unknown[]).slice(0, 64)).toEqual(traces[0]);
    }
  });

  it('keeps explicit Date behavior while replacing ambient time', async () => {
    const result = await run({
      source: `
        const explicit = new Date('2020-01-02T03:04:05.000Z');
        return {
          explicit: explicit.toISOString(),
          parsed: Date.parse('2020-01-02T03:04:05.000Z'),
          utc: Date.UTC(2020, 0, 2, 3, 4, 5),
          invalid: String(new Date('invalid')),
          constructor: explicit.constructor === Date,
          monotonic: Date.now() + 1 === Date.now(),
        };
      `,
    });
    expect(result).toEqual({
      status: 'completed',
      value: {
        constructor: true,
        explicit: '2020-01-02T03:04:05.000Z',
        invalid: 'Invalid Date',
        monotonic: true,
        parsed: 1_577_934_245_000,
        utc: 1_577_934_245_000,
      },
    });
  });

  it('rejects duplicate, unknown, missing, and extra resolutions before effects', async () => {
    const effect = vi.fn();
    const source = `
      return await Promise.all([tools.pause(1), tools.pause(2)]);
    `;
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'pause' });
          }
          effect(context.resume?.interruptionId);
          return context.resume?.resolution;
        },
      },
    };
    const interrupted = await run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected pause.');
    }
    const [first, second] = interrupted.interruptions;
    if (first === undefined || second === undefined) {
      throw new Error('Expected two interruptions.');
    }

    for (const resolutions of [
      [],
      [{ interruptionId: first.id, value: true }],
      [
        { interruptionId: first.id, value: true },
        { interruptionId: first.id, value: false },
      ],
      [
        { interruptionId: first.id, value: true },
        { interruptionId: 'unknown', value: true },
      ],
      [
        { interruptionId: first.id, value: true },
        { interruptionId: second.id, value: true },
        { interruptionId: 'extra', value: true },
      ],
    ]) {
      await expect(
        run({
          hostFunctions,
          continuation: interrupted.continuation,
          resolutions,
          source,
        }),
      ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    }
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(['first', 'middle', 'last'] as const)(
    'detects replay divergence at the %s ledger entry',
    async position => {
      let saved: RunContinuationState | undefined;
      let mutate = false;
      const runner = createRunner({
        continuationCodec: {
          decode() {
            if (!saved) {
              throw new Error('missing state');
            }
            const state = structuredClone(saved);
            if (mutate) {
              let index = state.ledger.length - 1;
              if (position === 'first') {
                index = 0;
              } else if (position === 'middle') {
                index = 1;
              }
              const entry = state.ledger[index];
              if (entry === undefined) {
                throw new Error('Expected a ledger entry.');
              }
              entry.inputJson = '"diverged"';
            }
            return state;
          },
          encode(state) {
            saved = structuredClone(state);
            return 'token';
          },
        },
      });
      const source = `
        await tools.effect('first');
        await tools.effect('middle');
        return await tools.pause('last');
      `;
      const hostFunctions = {
        tools: {
          effect: (input: unknown) => input,
          pause: () => {
            const context = getHostFunctionContext();
            if (!context.resume) {
              context.interrupt({ kind: 'pause' });
            }
            return context.resume?.resolution;
          },
        },
      };
      const interrupted = await runner.run({ hostFunctions, source });
      if (interrupted.status !== 'interrupted') {
        throw new Error('Expected pause.');
      }
      mutate = true;
      await expect(
        runner.run({
          hostFunctions,
          continuation: interrupted.continuation,
          resolutions: [
            { interruptionId: firstInterruptionId(interrupted), value: true },
          ],
          source,
        }),
      ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    },
  );

  it('preserves caught rejection and Promise.race ordering across replay', async () => {
    const effects = vi.fn(async ({ id }: { id: string }) => {
      await Promise.resolve();
      if (id === 'failure') {
        throw new Error('expected failure');
      }
      return id;
    });
    const source = `
      const failure = tools.effect({ id: 'failure' }).catch(error => error.message);
      const success = tools.effect({ id: 'success' });
      const race = await Promise.race([failure, success]);
      const all = await Promise.all([failure, success]);
      const resolution = await tools.pause();
      return { race, all, resolution };
    `;
    const hostFunctions = {
      tools: {
        effect: effects,
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'pause' });
          }
          return context.resume?.resolution;
        },
      },
    };
    const interrupted = await run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected pause.');
    }
    await expect(
      run({
        hostFunctions,
        continuation: interrupted.continuation,
        resolutions: [
          { interruptionId: firstInterruptionId(interrupted), value: true },
        ],
        source,
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: {
        all: ['Host function failed.', 'success'],
        race: 'Host function failed.',
        resolution: true,
      },
    });
    expect(effects).toHaveBeenCalledTimes(2);
  });

  it('replays a maximum-length completed ledger without duplicate effects', async () => {
    const effect = vi.fn((input: number) => input * 2);
    const count = 64;
    const source = `
      const values = [];
      for (let index = 0; index < ${count}; index++) {
        values.push(await tools.effect(index));
      }
      const resolution = await tools.pause();
      return { values, resolution };
    `;
    const hostFunctions = {
      tools: {
        effect,
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'pause' });
          }
          return context.resume?.resolution;
        },
      },
    };
    const interrupted = await run({
      hostFunctions,
      limits: { maxBridgeRequests: count + 1 },
      source,
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected pause.');
    }
    await expect(
      run({
        hostFunctions,
        continuation: interrupted.continuation,
        limits: { maxBridgeRequests: count + 1 },
        resolutions: [
          {
            interruptionId: firstInterruptionId(interrupted),
            value: 'done',
          },
        ],
        source,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      value: { resolution: 'done' },
    });
    expect(effect).toHaveBeenCalledTimes(count);
  });

  it('keeps a stable idempotency key when a signed continuation is retried', async () => {
    const interruptionIds: string[] = [];
    const source = 'return await tools.write();';
    const hostFunctions = {
      tools: {
        write: () => {
          const context = getHostFunctionContext();
          const { resume } = context;
          if (resume === undefined) {
            return context.interrupt({ kind: 'approval' });
          }
          interruptionIds.push(resume.interruptionId);
          return true;
        },
      },
    };
    const interrupted = await run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected pause.');
    }
    const input = {
      hostFunctions,
      continuation: interrupted.continuation,
      resolutions: [
        { interruptionId: firstInterruptionId(interrupted), value: true },
      ],
      source,
    };
    await run(input);
    await run(input);
    expect(interruptionIds).toEqual(['interrupt-1', 'interrupt-1']);
  });

  it('times out or reports custom codec encode failure and releases the slot', async () => {
    const hanging = createRunner({
      continuationCodec: {
        decode: () => {
          throw new Error('not used');
        },
        encode: () => createPromiseWithResolvers<never>().promise,
      },
      limits: { timeoutMs: 50 },
    });
    await expect(
      hanging.run({
        hostFunctions: {
          tools: {
            pause: () => getHostFunctionContext().interrupt({ kind: 'pause' }),
          },
        },
        source: 'return await tools.pause();',
      }),
    ).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
    await expect(run({ source: 'return 1;' })).resolves.toEqual({
      status: 'completed',
      value: 1,
    });

    const failing = createRunner({
      continuationCodec: {
        decode: () => {
          throw new Error('not used');
        },
        encode: () => {
          throw new Error('encode failed');
        },
      },
    });
    await expect(
      failing.run({
        hostFunctions: {
          tools: {
            pause: () => getHostFunctionContext().interrupt({ kind: 'pause' }),
          },
        },
        source: 'return await tools.pause();',
      }),
    ).rejects.toThrow('encode failed');
  });

  it('checks 100,000 generated traces against a replay effect model', () => {
    const next = createPrng(2_654_435_769);
    for (let trace = 0; trace < 100_000; trace += 1) {
      const actions = Array.from({ length: 1 + (next() % 16) }, () => {
        if (next() % 5 === 0) {
          return 'interrupted';
        }
        return next() % 4 === 0 ? 'rejected' : 'fulfilled';
      });
      const effects = Array.from({ length: actions.length }, () => 0);
      const ledger = new Set<number>();
      let pending: number | undefined;

      do {
        pending = undefined;
        for (const [index, action] of actions.entries()) {
          if (ledger.has(index)) {
            continue;
          }
          const effectCount = effects[index];
          if (effectCount === undefined) {
            throw new Error('Expected an effect counter.');
          }
          effects[index] = effectCount + 1;
          if (action === 'interrupted' && effects[index] === 1) {
            pending = index;
            break;
          }
          ledger.add(index);
        }
      } while (pending !== undefined);

      expect(ledger.size, `trace ${trace}`).toBe(actions.length);
      expect(effects, `trace ${trace}`).toEqual(
        actions.map(action => (action === 'interrupted' ? 2 : 1)),
      );
    }
  });

  it('matches production replay to generated sequential effect traces', async () => {
    const next = createPrng(3_235_826_430);
    for (let trace = 0; trace < 16; trace += 1) {
      let interruptionCount = 0;
      const actions = Array.from(
        { length: 1 + (next() % 6) },
        (_value, index) => {
          let status: 'fulfilled' | 'rejected' | 'interrupted';
          if (interruptionCount < 2 && next() % 3 === 0) {
            status = 'interrupted';
            interruptionCount += 1;
          } else {
            status = next() % 4 === 0 ? 'rejected' : 'fulfilled';
          }
          return { index, status };
        },
      );
      const calls = Array.from({ length: actions.length }, () => 0);
      const source = `
        const output = [];
        for (const action of ${JSON.stringify(actions)}) {
          try { output.push(await tools.effect(action)); }
          catch { output.push('rejected'); }
        }
        return output;
      `;
      const hostFunctions = {
        tools: {
          effect: (action: (typeof actions)[number]) => {
            const context = getHostFunctionContext();
            const callCount = calls[action.index];
            if (callCount === undefined) {
              throw new Error('Expected a call counter.');
            }
            calls[action.index] = callCount + 1;
            if (action.status === 'rejected') {
              throw new Error('expected');
            }
            if (action.status === 'interrupted' && !context.resume) {
              context.interrupt({ index: action.index });
            }
            return action.index;
          },
        },
      };

      let result = await run({ hostFunctions, source });
      while (result.status === 'interrupted') {
        result = await run({
          hostFunctions,
          continuation: result.continuation,
          resolutions: result.interruptions.map(interruption => ({
            interruptionId: interruption.id,
            value: true,
          })),
          source,
        });
      }
      expect(result.value, `trace ${trace}`).toEqual(
        actions.map(action =>
          action.status === 'rejected' ? 'rejected' : action.index,
        ),
      );
      expect(calls, `trace ${trace}`).toEqual(
        actions.map(action => (action.status === 'interrupted' ? 2 : 1)),
      );
    }
  });
});
