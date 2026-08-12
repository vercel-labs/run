import { describe, expect, it, vi } from 'vitest';
import {
  createRunner,
  createSignedContinuationCodec,
  createStoredContinuationCodec,
  getHostFunctionContext,
  run,
  setMaxWorkers,
} from './index.js';
import type {
  ContinuationStorage,
  RunInterruptedResult,
  RunInterruption,
  StoredContinuation,
} from './index.js';
import { createPromiseWithResolvers } from './utils/promise-with-resolvers.js';

const firstInterruption = (result: RunInterruptedResult): RunInterruption => {
  const interruption = result.interruptions.at(0);
  if (interruption === undefined) {
    throw new Error('Expected an interruption.');
  }
  return interruption;
};

const sleep = async (delay: number): Promise<void> => {
  const deferred = createPromiseWithResolvers<null>();
  setTimeout(() => deferred.resolve(null), delay);
  await deferred.promise;
};

const createMemoryContinuationStorage = (): {
  storage: ContinuationStorage;
  values: Map<string, StoredContinuation>;
} => {
  const values = new Map<string, StoredContinuation>();
  const leases = new Map<string, string>();
  return {
    storage: {
      acquire(key, leaseId) {
        if (leases.has(key)) {
          return;
        }
        const value = values.get(key);
        if (value !== undefined) {
          leases.set(key, leaseId);
        }
        return value;
      },
      consume(key, leaseId) {
        if (leases.get(key) === leaseId) {
          leases.delete(key);
          values.delete(key);
        }
      },
      release(key, leaseId) {
        if (leases.get(key) === leaseId) {
          leases.delete(key);
        }
      },
      set(key, value) {
        values.set(key, value);
      },
    },
    values,
  };
};

describe('run', () => {
  it('keeps concurrent worker realms and host function closures isolated', async () => {
    setMaxWorkers(4);
    const releases: (() => void)[] = [];
    const started = createPromiseWithResolvers<null>();
    try {
      const executions = Array.from({ length: 4 }, (_, index) =>
        run<number>({
          hostFunctions: {
            tools: {
              wait: async () => {
                const release = createPromiseWithResolvers<null>();
                releases.push(() => release.resolve(null));
                if (releases.length === 4) {
                  started.resolve(null);
                }
                await release.promise;
              },
            },
          },
          source: `
            globalThis.marker = ${index};
            await tools.wait();
            return globalThis.marker;
          `,
        }),
      );
      await started.promise;
      for (const release of releases) {
        release();
      }
      await expect(Promise.all(executions)).resolves.toEqual(
        Array.from({ length: 4 }, (_, value) => ({
          status: 'completed',
          value,
        })),
      );
    } finally {
      setMaxWorkers(undefined);
    }
  });

  it('executes JavaScript and returns a completed result', async () => {
    await expect(run({ source: 'return 2 + 3;' })).resolves.toEqual({
      status: 'completed',
      value: 5,
    });
  });

  it('exposes named host function groups as guest globals', async () => {
    const add = vi.fn(({ a, b }: { a: number; b: number }) => a + b);

    await expect(
      run({
        hostFunctions: { tools: { add } },
        source: 'return await tools.add({ a: 2, b: 3 });',
      }),
    ).resolves.toEqual({ status: 'completed', value: 5 });
    expect(add).toHaveBeenCalledWith({ a: 2, b: 3 });
  });

  it('maps every guest argument to the host function signature', async () => {
    const sum = vi.fn((...values: number[]) =>
      values.reduce((total, value) => total + value, 0),
    );

    await expect(
      run({
        hostFunctions: { tools: { sum } },
        source: 'return await tools.sum(1, 2, 3, 4);',
      }),
    ).resolves.toEqual({ status: 'completed', value: 10 });
    expect(sum).toHaveBeenCalledWith(1, 2, 3, 4);
  });

  it('scopes host function context through async work and invalidates it after settlement', async () => {
    const requestIds = new Map<string, string>();
    const result = await run<string[]>({
      hostFunctions: {
        tools: {
          inspect: async (label: string) => {
            const before = getHostFunctionContext();
            await Promise.resolve();
            const after = getHostFunctionContext();
            expect(after).toBe(before);
            requestIds.set(label, before.requestId);
            return `${label}:${before.requestId}`;
          },
        },
      },
      source: `
        return await Promise.all([
          tools.inspect('first'),
          tools.inspect('second'),
        ]);
      `,
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(new Set(result.value).size).toBe(2);
    }
    expect(requestIds.get('first')).not.toBe(requestIds.get('second'));
    expect(() => getHostFunctionContext()).toThrow(
      'getHostFunctionContext() can only be called while executing a host function.',
    );
  });

  it('invalidates context in detached async work after host function settlement', async () => {
    const detachedGate = createPromiseWithResolvers<null>();
    const detachedContext = createPromiseWithResolvers<unknown>();

    await expect(
      run({
        hostFunctions: {
          tools: {
            detach: () => {
              const inspectDetachedContext = async () => {
                await detachedGate.promise;
                try {
                  detachedContext.resolve(getHostFunctionContext());
                } catch (error) {
                  detachedContext.resolve(error);
                }
              };
              inspectDetachedContext().catch(detachedContext.resolve);
              return 'done';
            },
          },
        },
        source: 'return await tools.detach();',
      }),
    ).resolves.toEqual({ status: 'completed', value: 'done' });
    detachedGate.resolve(null);
    await expect(detachedContext.promise).resolves.toMatchObject({
      message:
        'getHostFunctionContext() can only be called while executing a host function.',
    });
  });

  it('keeps host function context active after abort while the host function is pending', async () => {
    const abortController = new AbortController();
    const hostFunctionStarted = createPromiseWithResolvers<null>();
    const detachedGate = createPromiseWithResolvers<null>();
    const detachedContext = createPromiseWithResolvers<unknown>();
    const execution = run({
      abortSignal: abortController.signal,
      hostFunctions: {
        tools: {
          wait: () => {
            const inspectDetachedContext = async () => {
              await detachedGate.promise;
              try {
                detachedContext.resolve(getHostFunctionContext());
              } catch (error) {
                detachedContext.resolve(error);
              }
            };
            inspectDetachedContext().catch(detachedContext.resolve);
            hostFunctionStarted.resolve(null);
            return createPromiseWithResolvers<never>().promise;
          },
        },
      },
      source: 'return await tools.wait();',
    });
    await hostFunctionStarted.promise;
    abortController.abort();
    await expect(execution).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    detachedGate.resolve(null);
    await expect(detachedContext.promise).resolves.toMatchObject({
      abortSignal: { aborted: true },
      hostFunctionName: 'tools.wait',
    });
  });

  it('supports concurrent host function calls', async () => {
    const result = await run<number[]>({
      hostFunctions: {
        functions: { double: (value: number) => value * 2 },
      },
      source: `
        return await Promise.all([
          functions.double(2),
          functions.double(3),
        ]);
      `,
    });

    if (result.status !== 'completed') {
      throw new Error('Expected completed result.');
    }
    expect(result.value).toEqual([4, 6]);
  });

  it('strips TypeScript syntax from function-body source', async () => {
    const result = await run<number>({
      source: 'const value: number = 42; return value;',
    });
    if (result.status !== 'completed') {
      throw new Error('Expected completed result.');
    }
    expect(result.value).toBe(42);
  });

  it('rejects unknown host functions', async () => {
    await expect(
      run({
        hostFunctions: { tools: {} },
        source: 'return await tools.missing();',
      }),
    ).rejects.toMatchObject({ code: 'RUN_HOST_FUNCTION_ERROR' });
  });

  it('does not invoke inherited host function group properties', async () => {
    const inherited = vi.fn(() => 'should not run');
    const group = Object.assign(Object.create({ inherited }), {
      safe: () => 'safe',
    });

    await expect(
      run({
        hostFunctions: { tools: group },
        source: 'return await tools.inherited({ attacker: true });',
      }),
    ).rejects.toMatchObject({ code: 'RUN_HOST_FUNCTION_ERROR' });
    expect(inherited).not.toHaveBeenCalled();
  });

  it.each(['constructor', 'hasOwnProperty', 'valueOf'])(
    'does not expose Object.prototype.%s as a host function',
    async name => {
      await expect(
        run({
          hostFunctions: { tools: { safe: () => 'safe' } },
          source: `return await tools.${name}({ attacker: true });`,
        }),
      ).rejects.toMatchObject({ code: 'RUN_HOST_FUNCTION_ERROR' });
    },
  );

  it('rechecks that a host function is a function at invocation time', async () => {
    const group = {
      mutate: () => {
        (group as Record<string, unknown>).target = 'not a function';
      },
      target: () => 'should not run',
    };

    await expect(
      run({
        hostFunctions: { tools: group },
        source: 'await tools.mutate(); return await tools.target();',
      }),
    ).rejects.toMatchObject({ code: 'RUN_HOST_FUNCTION_ERROR' });
  });

  it('rejects reserved guest namespaces', async () => {
    await expect(
      run({
        hostFunctions: { console: { log: () => {} } },
        source: 'return 1;',
      }),
    ).rejects.toThrow('Reserved host function namespace: console');
  });

  it('resumes an interrupted host function without repeating completed effects', async () => {
    const effect = vi.fn(() => 'created');
    const approve = vi.fn(() => {
      const context = getHostFunctionContext();
      if (context.resume === undefined) {
        context.interrupt({ kind: 'approval', message: 'Allow it?' });
      }
      return context.resume?.resolution;
    });
    const input = {
      hostFunctions: { tools: { approve, effect } },
      source: `
        const created = await tools.effect();
        const approved = await tools.approve();
        return { created, approved };
      `,
    };

    const interrupted = await run(input);
    expect(interrupted).toMatchObject({
      interruptions: [
        {
          arguments: [],
          hostFunctionName: 'tools.approve',
          id: 'interrupt-2',
          payload: { kind: 'approval', message: 'Allow it?' },
        },
      ],
      status: 'interrupted',
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }

    await expect(
      run({
        ...input,
        continuation: interrupted.continuation,
        resolutions: [
          { interruptionId: firstInterruption(interrupted).id, value: true },
        ],
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: { approved: true, created: 'created' },
    });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('batches concurrent interruptions into one continuation', async () => {
    const approval = vi.fn((input: { name: string }) => {
      const context = getHostFunctionContext();
      if (context.resume === undefined) {
        context.interrupt({ kind: 'approval', name: input.name });
      }
      return context.resume?.resolution;
    });
    const input = {
      hostFunctions: { tools: { approval } },
      source: `
        return await Promise.all([
          tools.approval({ name: 'first' }),
          tools.approval({ name: 'second' }),
        ]);
      `,
    };

    const interrupted = await run(input);
    expect(interrupted.status).toBe('interrupted');
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    expect(interrupted.interruptions).toHaveLength(2);

    await expect(
      run({
        ...input,
        continuation: interrupted.continuation,
        resolutions: [
          {
            interruptionId: firstInterruption(interrupted).id,
            value: 'only one',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });

    await expect(
      run({
        ...input,
        continuation: interrupted.continuation,
        resolutions: interrupted.interruptions.map((item, index) => ({
          interruptionId: item.id,
          value: index === 0 ? 'yes' : 'also yes',
        })),
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: ['yes', 'also yes'],
    });
  });

  it('rejects tampered signed continuations', async () => {
    const interrupted = await run({
      hostFunctions: {
        tools: {
          pause: () => getHostFunctionContext().interrupt({ kind: 'pause' }),
        },
      },
      source: 'return await tools.pause();',
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    const token = interrupted.continuation as string;
    await expect(
      run({
        hostFunctions: { tools: { pause: () => {} } },
        continuation: `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`,
        source: 'return await tools.pause();',
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
  });

  it('replays Date and Math.random deterministically across host functions', async () => {
    const effectInputs: unknown[] = [];
    const source = `
      const before = { now: Date.now(), random: Math.random() };
      await tools.effect(before);
      const between = { now: Date.now(), random: Math.random() };
      const approved = await tools.approve(between);
      return {
        before,
        between,
        after: { now: Date.now(), random: Math.random() },
        approved,
      };
    `;
    const hostFunctions = {
      tools: {
        approve: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'approval' });
          }
          return context.resume?.resolution;
        },
        effect: (input: unknown) => {
          effectInputs.push(input);
        },
      },
    };

    const interrupted = await run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    const completed = await run({
      hostFunctions,
      continuation: interrupted.continuation,
      resolutions: [
        { interruptionId: firstInterruption(interrupted).id, value: true },
      ],
      source,
    });
    expect(completed).toMatchObject({ status: 'completed' });
    expect(effectInputs).toHaveLength(1);
    if (completed.status === 'completed') {
      expect(completed.value).toMatchObject({
        approved: true,
        before: effectInputs[0],
      });
    }
  });

  it('supports sequential interruption rounds', async () => {
    const source = `
      const first = await tools.pause({ step: 1 });
      const second = await tools.pause({ step: 2 });
      return [first, second];
    `;
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'approval' });
          }
          return context.resume?.resolution;
        },
      },
    };
    const first = await run({ hostFunctions, source });
    if (first.status !== 'interrupted') {
      throw new Error('Expected first round.');
    }
    const second = await run({
      hostFunctions,
      continuation: first.continuation,
      resolutions: [
        { interruptionId: firstInterruption(first).id, value: 'a' },
      ],
      source,
    });
    if (second.status !== 'interrupted') {
      throw new Error('Expected second round.');
    }
    await expect(
      run({
        hostFunctions,
        continuation: second.continuation,
        resolutions: [
          { interruptionId: firstInterruption(second).id, value: 'b' },
        ],
        source,
      }),
    ).resolves.toEqual({ status: 'completed', value: ['a', 'b'] });
  });

  it('replays rejected host functions without reinvoking them', async () => {
    const fail = vi.fn(() => {
      throw new Error('secret failure');
    });
    const source = `
      let failure;
      try { await tools.fail(); } catch (error) { failure = error.message; }
      const approved = await tools.approve();
      return { failure, approved };
    `;
    const hostFunctions = {
      tools: {
        approve: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'approval' });
          }
          return context.resume?.resolution;
        },
        fail,
      },
    };
    const interrupted = await run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    await run({
      hostFunctions,
      continuation: interrupted.continuation,
      resolutions: [
        { interruptionId: firstInterruption(interrupted).id, value: true },
      ],
      source,
    });
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed decoded state and times out hanging codecs', async () => {
    const malformedRunner = createRunner({
      continuationCodec: {
        decode: () => ({ version: 1 }) as never,
        encode: () => 'unused',
      },
    });
    await expect(
      malformedRunner.run({ continuation: 'bad', source: 'return 1;' }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });

    const hangingRunner = createRunner({
      continuationCodec: {
        decode: () => createPromiseWithResolvers<never>().promise,
        encode: () => 'unused',
      },
      limits: { timeoutMs: 20 },
    });
    await expect(
      hangingRunner.run({ continuation: 'pending', source: 'return 1;' }),
    ).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
  });

  it('aborts a hanging continuation decode', async () => {
    let codecSignal: AbortSignal | undefined;
    const runner = createRunner({
      continuationCodec: {
        decode: (_token, context) => {
          codecSignal = context?.abortSignal;
          return createPromiseWithResolvers<never>().promise;
        },
        encode: () => 'unused',
      },
      limits: { timeoutMs: 1000 },
    });
    const abortController = new AbortController();
    const result = runner.run({
      abortSignal: abortController.signal,
      continuation: 'pending',
      source: 'return 1;',
    });
    abortController.abort();
    await expect(result).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(codecSignal?.aborted).toBe(true);
  });

  it('rolls back a continuation transaction that finishes after abort', async () => {
    const decodeStarted = createPromiseWithResolvers<null>();
    const finishDecode = createPromiseWithResolvers<null>();
    const rollback = vi.fn();
    const runner = createRunner({
      continuationCodec: {
        decode: () => {
          throw new Error('transactional decode should be used');
        },
        async decodeTransaction() {
          decodeStarted.resolve(null);
          await finishDecode.promise;
          return {
            commit: vi.fn(),
            rollback,
            state: {} as never,
          };
        },
        encode: () => 'unused',
      },
      limits: { timeoutMs: 1000 },
    });
    const abortController = new AbortController();
    const result = runner.run({
      abortSignal: abortController.signal,
      continuation: 'pending',
      source: 'return 1;',
    });

    await decodeStarted.promise;
    abortController.abort();
    await expect(result).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    finishDecode.resolve(null);
    await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce());
  });

  it('releases stored continuations rejected by replay validation', async () => {
    const { storage } = createMemoryContinuationStorage();
    const runner = createRunner({
      continuationCodec: createStoredContinuationCodec({ storage }),
    });
    const source = 'return await tools.pause();';
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          if (context.resume === undefined) {
            context.interrupt({ kind: 'approval' });
          }
          return context.resume?.resolution;
        },
      },
    };
    const interrupted = await runner.run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    const resume = {
      hostFunctions,
      continuation: interrupted.continuation,
      resolutions: [
        { interruptionId: firstInterruption(interrupted).id, value: true },
      ],
    };

    await expect(
      runner.run({ ...resume, source: 'return "changed";' }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    await expect(runner.run({ ...resume, source })).resolves.toEqual({
      status: 'completed',
      value: true,
    });
  });

  it('enforces aggregate continuation limits', async () => {
    await expect(
      run({
        hostFunctions: {
          tools: {
            pause: () =>
              getHostFunctionContext().interrupt({
                detail: 'x'.repeat(200),
                kind: 'approval',
              }),
          },
        },
        limits: { maxContinuationBytes: 128 },
        source: 'return await tools.pause("large-input");',
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
  });

  it('batches a larger concurrent interruption set at the worker barrier', async () => {
    const source = `
      return await Promise.all(
        Array.from({ length: 16 }, (_value, index) => tools.pause(index))
      );
    `;
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
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
    expect(interrupted.interruptions).toHaveLength(16);
    await expect(
      run({
        hostFunctions,
        continuation: interrupted.continuation,
        resolutions: interrupted.interruptions.map((item, index) => ({
          interruptionId: item.id,
          value: index,
        })),
        source,
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: Array.from({ length: 16 }, (_value, index) => index),
    });
  });

  it('preserves concurrent host function settlement order during replay', async () => {
    const delayed = vi.fn(
      async ({ id, delay }: { id: string; delay: number }) => {
        await sleep(delay);
        return id;
      },
    );
    const source = `
      const slow = tools.delayed({ id: 'slow', delay: 20 });
      const fast = tools.delayed({ id: 'fast', delay: 0 });
      const winner = await Promise.race([slow, fast]);
      const all = await Promise.all([slow, fast]);
      const approved = await tools.pause();
      return { winner, all, approved };
    `;
    const hostFunctions = {
      tools: {
        delayed,
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
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
    await expect(
      run({
        hostFunctions,
        continuation: interrupted.continuation,
        resolutions: [
          { interruptionId: firstInterruption(interrupted).id, value: true },
        ],
        source,
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: { all: ['slow', 'fast'], approved: true, winner: 'fast' },
    });
    expect(delayed).toHaveBeenCalledTimes(2);
  });

  it('returns an observed interruption after the worker is already ready', async () => {
    const signed = createSignedContinuationCodec({ secret: 's'.repeat(32) });
    const runner = createRunner({
      continuationCodec: {
        decode: signed.decode,
        async encode(state, context) {
          await sleep(20);
          return signed.encode(state, context);
        },
      },
    });

    await expect(
      runner.run({
        hostFunctions: {
          tools: {
            pause: () => getHostFunctionContext().interrupt({ kind: 'pause' }),
          },
        },
        source: `
          return await Promise.race([
            tools.pause(),
            Promise.resolve('fast'),
          ]);
        `,
      }),
    ).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('binds continuations to audience, caller context, and host function manifest', async () => {
    const codec = createSignedContinuationCodec({ secret: 'x'.repeat(32) });
    const source = 'return await tools.pause();';
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          const { resume } = context;
          if (resume === undefined) {
            return context.interrupt({ kind: 'pause' });
          }
          return resume.resolution;
        },
      },
    };
    const runner = createRunner({
      continuationAudience: 'endpoint-a',
      continuationCodec: codec,
    });
    const first = await runner.run({
      hostFunctions,
      continuationContext: { tenantId: 'tenant-a' },
      source,
    });
    if (first.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    const resume = {
      hostFunctions,
      continuation: first.continuation,
      resolutions: [
        { interruptionId: firstInterruption(first).id, value: true },
      ],
      source,
    };

    await expect(
      createRunner({
        continuationAudience: 'endpoint-b',
        continuationCodec: codec,
      }).run({
        ...resume,
        continuationContext: { tenantId: 'tenant-a' },
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    await expect(
      runner.run({
        ...resume,
        continuationContext: { tenantId: 'tenant-b' },
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    await expect(
      runner.run({
        ...resume,
        hostFunctions: { tools: { ...hostFunctions.tools, extra: () => true } },
        continuationContext: { tenantId: 'tenant-a' },
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
  });

  it('rejects non-exact resolution envelopes', async () => {
    const source = 'return await tools.pause();';
    const hostFunctions = {
      tools: {
        pause: () => getHostFunctionContext().interrupt({ kind: 'pause' }),
      },
    };
    const first = await run({ hostFunctions, source });
    if (first.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    await expect(
      run({
        hostFunctions,
        continuation: first.continuation,
        resolutions: [
          {
            extra: true,
            interruptionId: firstInterruption(first).id,
            value: true,
          } as never,
        ],
        source,
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
  });

  it('requires signing configuration only when a continuation is used', async () => {
    const previous = process.env.RUN_CONTINUATION_SECRET;
    delete process.env.RUN_CONTINUATION_SECRET;
    const runner = createRunner();
    if (previous !== undefined) {
      process.env.RUN_CONTINUATION_SECRET = previous;
    }

    await expect(runner.run({ source: 'return 1;' })).resolves.toEqual({
      status: 'completed',
      value: 1,
    });
    await expect(
      runner.run({
        hostFunctions: {
          tools: {
            pause: () => getHostFunctionContext().interrupt({ kind: 'pause' }),
          },
        },
        source: 'return await tools.pause();',
      }),
    ).rejects.toThrow('Continuation signing is not configured');
  });

  it('resumes across runners that share a continuation secret', async () => {
    const firstRunner = createRunner({ continuationSecret: 'a'.repeat(32) });
    const secondRunner = createRunner({ continuationSecret: 'a'.repeat(32) });
    const input = {
      hostFunctions: {
        tools: {
          pause: () => {
            const context = getHostFunctionContext();
            const { resume } = context;
            if (resume === undefined) {
              return context.interrupt({ kind: 'pause' });
            }
            return resume.resolution;
          },
        },
      },
      source: 'return await tools.pause();',
    };
    const interrupted = await firstRunner.run(input);
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    await expect(
      secondRunner.run({
        ...input,
        continuation: interrupted.continuation,
        resolutions: [
          {
            interruptionId: firstInterruption(interrupted).id,
            value: 'approved',
          },
        ],
      }),
    ).resolves.toEqual({ status: 'completed', value: 'approved' });
  });

  it('uses RUN_CONTINUATION_SECRET across independently created runners', async () => {
    const firstRunner = createRunner();
    const secondRunner = createRunner();
    const source = 'return await tools.pause("environment");';
    const hostFunctions = {
      tools: {
        pause: (label: string) => {
          const context = getHostFunctionContext();
          const { resume } = context;
          if (resume === undefined) {
            return context.interrupt({ label });
          }
          return resume.resolution;
        },
      },
    };
    const interrupted = await firstRunner.run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    expect(firstInterruption(interrupted).arguments).toEqual(['environment']);
    await expect(
      secondRunner.run({
        hostFunctions,
        continuation: interrupted.continuation,
        resolutions: [
          {
            interruptionId: firstInterruption(interrupted).id,
            value: 'resumed',
          },
        ],
        source,
      }),
    ).resolves.toEqual({ status: 'completed', value: 'resumed' });
  });

  it('rejects conflicting continuation signing options', () => {
    expect(() =>
      createRunner({
        continuationCodec: createSignedContinuationCodec({
          secret: 'b'.repeat(32),
        }),
        continuationSecret: 'a'.repeat(32),
      }),
    ).toThrow('cannot be used together');
  });
});
