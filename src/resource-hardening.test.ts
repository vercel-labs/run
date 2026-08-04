import { describe, expect, it, vi } from 'vitest';
import {
  RunBridgeLimitError,
  RunDetachedBridgeRequestError,
  RunTimeoutError,
} from './errors.js';
import { getBindingContext } from './binding-context.js';
import { run } from './run.js';
import { getRuntimeDiagnostics } from './runtime/manager.js';
import type { RunLimits } from './types.js';

const LIMIT_NAMES = [
  'timeoutMs',
  'memoryLimitBytes',
  'maxStackSizeBytes',
  'maxResultBytes',
  'maxConsoleOutputBytes',
  'maxSourceBytes',
  'maxBindingArgumentsBytes',
  'maxBindingOutputBytes',
  'maxBridgeRequests',
  'maxInFlightBridgeRequests',
  'maxContinuationBytes',
] as const;

describe('resource and lifecycle hardening', () => {
  it.each(LIMIT_NAMES)(
    'rejects invalid %s values before worker creation',
    async name => {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
          run({
            limits: { [name]: value },
            source: 'return 1;',
          }),
        ).rejects.toThrow(`${name} must be a positive integer`);
      }
    },
  );

  it('terminates CPU, recursion, allocation, and microtask storms', async () => {
    const cases: { source: string; limits?: RunLimits }[] = [
      { source: 'while (true) {}' },
      {
        limits: { maxStackSizeBytes: 64 * 1024 },
        source: 'function recurse() { return recurse(); } return recurse();',
      },
      {
        limits: { memoryLimitBytes: 8 * 1024 * 1024 },
        source: `
          const values = [];
          while (true) values.push(new Array(10000).fill('xxxxxxxx'));
        `,
      },
      { source: 'while (true) await Promise.resolve();' },
    ];
    for (const item of cases) {
      await expect(
        run({
          limits: { timeoutMs: 250, ...item.limits },
          source: item.source,
        }),
      ).rejects.toThrow(/timed out|interrupted|memory|stack|recursion/i);
      await expect(run({ source: "return 'recovered';" })).resolves.toEqual({
        status: 'completed',
        value: 'recovered',
      });
    }
  });

  it('aborts a pending binding on timeout and releases runtime capacity', async () => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const execution = run({
      bindings: {
        tools: {
          wait: async () => {
            const context = getBindingContext();
            started.resolve();
            await new Promise((_resolve, reject) => {
              context.abortSignal.addEventListener(
                'abort',
                () => {
                  aborted.resolve();
                  reject(new Error('binding observed abort'));
                },
                { once: true },
              );
            });
          },
        },
      },
      limits: { timeoutMs: 200 },
      source: 'return await tools.wait();',
    });
    await started.promise;
    await expect(execution).rejects.toBeInstanceOf(RunTimeoutError);
    await aborted.promise;
    await expect(run({ source: 'return 42;' })).resolves.toEqual({
      status: 'completed',
      value: 42,
    });
  });

  it('does not settle retired-worker paths until thread termination completes', async () => {
    const interrupted = await run({
      bindings: {
        tools: {
          pause: () => getBindingContext().interrupt({ kind: 'pause' }),
        },
      },
      source: 'return await tools.pause();',
    });
    expect(interrupted.status).toBe('interrupted');
    expect(getRuntimeDiagnostics().terminatingWorkers).toBe(0);

    await expect(
      run({
        limits: { timeoutMs: 25 },
        source: 'while (true) {}',
      }),
    ).rejects.toBeInstanceOf(RunTimeoutError);
    expect(getRuntimeDiagnostics()).toMatchObject({
      activeInvocations: 0,
      terminatingWorkers: 0,
    });
  });

  it('makes caller abort win once and aborts active bindings', async () => {
    const started = deferred<void>();
    const observedReasons: unknown[] = [];
    const controller = new AbortController();
    const execution = run({
      abortSignal: controller.signal,
      bindings: {
        tools: {
          wait: async () => {
            const context = getBindingContext();
            started.resolve();
            await new Promise((_resolve, reject) => {
              context.abortSignal.addEventListener('abort', () => {
                observedReasons.push(context.abortSignal.reason);
                reject(context.abortSignal.reason);
              });
            });
          },
        },
      },
      limits: { timeoutMs: 5000 },
      source: 'return await tools.wait();',
    });
    await started.promise;
    controller.abort(new Error('caller reason must not leak'));
    controller.abort(new Error('second reason'));
    await expect(execution).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(observedReasons).toHaveLength(1);
  });

  it('rejects unobserved and observed-detached bindings and cleans up', async () => {
    const never = vi.fn(async () => await new Promise(() => {}));
    await expect(
      run({
        bindings: { tools: { never } },
        source: "tools.never(); return 'done';",
      }),
    ).rejects.toBeInstanceOf(RunDetachedBridgeRequestError);
    expect(never).not.toHaveBeenCalled();

    const started = deferred<void>();
    const aborted = deferred<void>();
    await expect(
      run({
        bindings: {
          tools: {
            wait: async () => {
              const context = getBindingContext();
              started.resolve();
              await new Promise((_resolve, reject) => {
                context.abortSignal.addEventListener('abort', () => {
                  aborted.resolve();
                  reject(new Error('detached binding aborted'));
                });
              });
            },
          },
        },
        source: "tools.wait().then(() => undefined); return 'done';",
      }),
    ).rejects.toBeInstanceOf(RunDetachedBridgeRequestError);
    await started.promise;
    await aborted.promise;
    await expect(run({ source: "return 'clean';" })).resolves.toEqual({
      status: 'completed',
      value: 'clean',
    });
  });

  it('enforces total and in-flight bridge limits before extra host dispatch', async () => {
    const sequential = vi.fn((input: unknown) => input);
    await expect(
      run({
        bindings: { tools: { echo: sequential } },
        limits: { maxBridgeRequests: 1 },
        source: 'await tools.echo(1); return await tools.echo(2);',
      }),
    ).rejects.toBeInstanceOf(RunBridgeLimitError);
    expect(sequential).toHaveBeenCalledTimes(1);

    const started = deferred<void>();
    const aborted = deferred<void>();
    const parallel = vi.fn(async () => {
      const context = getBindingContext();
      started.resolve();
      await new Promise((_resolve, reject) => {
        context.abortSignal.addEventListener('abort', () => {
          aborted.resolve();
          reject(new Error('aborted'));
        });
      });
    });
    const execution = run({
      bindings: { tools: { wait: parallel } },
      limits: { maxInFlightBridgeRequests: 1 },
      source: 'return await Promise.all([tools.wait(1), tools.wait(2)]);',
    });
    await started.promise;
    await expect(execution).rejects.toBeInstanceOf(RunBridgeLimitError);
    await aborted.promise;
    expect(parallel).toHaveBeenCalledTimes(1);
  });

  it('rejects aggregate continuation amplification across legal entries', async () => {
    const source = `
      await tools.large(1);
      await tools.large(2);
      await tools.large(3);
      return await tools.pause();
    `;
    await expect(
      run({
        bindings: {
          tools: {
            large: () => 'x'.repeat(180),
            pause: () => getBindingContext().interrupt({ kind: 'pause' }),
          },
        },
        limits: {
          maxBindingOutputBytes: 1024,
          maxContinuationBytes: 700,
        },
        source,
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
