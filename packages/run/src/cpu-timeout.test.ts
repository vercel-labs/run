import { describe, expect, it, vi } from 'vitest';
import {
  RunCpuTimeoutError,
  RunTimeoutError,
  createRunner,
  getHostFunctionContext,
  run,
} from './index.js';
import type { RunInput } from './index.js';
import { normalizeOptions } from './utils/options.js';
import { createPromiseWithResolvers } from './utils/promise-with-resolvers.js';

const sleep = async (ms: number): Promise<number> => {
  const deferred = createPromiseWithResolvers<number>();
  setTimeout(() => deferred.resolve(ms), ms);
  return await deferred.promise;
};

const spin = (iterations: number): string =>
  `{ let total = 0; for (let i = 0; i < ${iterations}; i++) total += i; }`;

// The limit is enforced at QuickJS interrupt checks, so guest code must keep
// running after a host wait for wrongly counted wait time to be observed.
const GUEST_WORK_AFTER_WAIT = spin(1_000_000);

async function elapsed(
  operation: () => Promise<unknown>,
): Promise<{ ms: number; error: unknown }> {
  const start = performance.now();
  const failure = await operation().then(
    () => {},
    (error: unknown) => error,
  );
  return { error: failure, ms: performance.now() - start };
}

// Uses the faster of two samples so a scheduling hiccup cannot make the
// calibrated work too small to exceed the budget.
async function measureSpinIterationsPerMs(): Promise<number> {
  const iterations = 10_000_000;
  let fastestMs = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 2; sample += 1) {
    const baseline = await elapsed(() => run({ source: 'return 0;' }));
    const measured = await elapsed(() =>
      run({ source: `${spin(iterations)} return 0;` }),
    );
    fastestMs = Math.min(fastestMs, measured.ms - baseline.ms);
  }
  return iterations / Math.max(1, fastestMs);
}

describe('cpuTimeoutMs', () => {
  it('defaults to 30 seconds', () => {
    expect(normalizeOptions({}).cpuTimeoutMs).toBe(30_000);
  });

  it('stops a busy loop with RUN_CPU_TIMEOUT near the CPU limit', async () => {
    const { error, ms } = await elapsed(() =>
      run({
        limits: { cpuTimeoutMs: 200, timeoutMs: 10_000 },
        source: 'while (true) {}',
      }),
    );
    expect(error).toBeInstanceOf(RunCpuTimeoutError);
    expect(error).toMatchObject({
      code: 'RUN_CPU_TIMEOUT',
      details: { cpuTimeoutMs: 200 },
      message: 'JavaScript runtime exceeded its CPU time limit of 200ms.',
    });
    expect(ms).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(5000);
  });

  it.each([
    ['a microtask storm', 'while (true) await Promise.resolve();'],
    [
      'guest code resumed by a host function response',
      'await tools.echo(1); while (true) {}',
    ],
    [
      'a pending job after a host function response',
      'await tools.echo(1); Promise.resolve().then(() => { while (true) {} }); await tools.echo(2);',
    ],
  ])('reports RUN_CPU_TIMEOUT for %s', async (_name, source) => {
    await expect(
      run({
        hostFunctions: { tools: { echo: (value: unknown) => value } },
        limits: { cpuTimeoutMs: 200, timeoutMs: 10_000 },
        source,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_CPU_TIMEOUT',
      message: 'JavaScript runtime exceeded its CPU time limit of 200ms.',
    });
  });

  it('completes a long loop that exceeded the former interrupt-check cap', async () => {
    await expect(
      run({ source: 'for (let i = 0; i < 60_000_000; i++) {} return "done";' }),
    ).resolves.toEqual({ status: 'completed', value: 'done' });
  });

  it('does not count time awaiting asynchronous host functions', async () => {
    await expect(
      run({
        hostFunctions: { tools: { sleep } },
        limits: { cpuTimeoutMs: 150, timeoutMs: 5000 },
        source: `
          const first = await tools.sleep(300);
          const rest = await Promise.all([tools.sleep(200), tools.sleep(200)]);
          ${GUEST_WORK_AFTER_WAIT}
          return first + rest[0] + rest[1];
        `,
      }),
    ).resolves.toEqual({ status: 'completed', value: 700 });
  });

  it('does not count time blocked in synchronous host functions', async () => {
    const runner = createRunner({
      limits: { cpuTimeoutMs: 150, timeoutMs: 5000 },
      syncHostFunctions: { tools: { sleep } },
    });
    await expect(
      runner.run({
        source: `
          const total = tools.sleep(300) + tools.sleep(300);
          ${GUEST_WORK_AFTER_WAIT}
          return total;
        `,
      }),
    ).resolves.toEqual({ status: 'completed', value: 600 });
  });

  it('does not count time blocked in module loaders', async () => {
    const load = vi.fn(async (specifier: string) => {
      await sleep(300);
      return specifier === './entry.js'
        ? "import { value } from './value.js'; export default value;"
        : 'export const value = 1;';
    });
    await expect(
      run({
        limits: { cpuTimeoutMs: 150, timeoutMs: 5000 },
        moduleLoader: { load },
        source: `
          const { default: value } = await import('./entry.js');
          ${GUEST_WORK_AFTER_WAIT}
          return value;
        `,
        sourceType: 'function-body',
      }),
    ).resolves.toEqual({ status: 'completed', value: 1 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps timeoutMs as the wall-clock ceiling for slow host functions', async () => {
    await expect(
      run({
        hostFunctions: { tools: { sleep } },
        limits: { cpuTimeoutMs: 10_000, timeoutMs: 300 },
        source: 'return await tools.sleep(2000);',
      }),
    ).rejects.toBeInstanceOf(RunTimeoutError);
  });

  it('completes many host calls with large arguments (#76)', async () => {
    let calls = 0;
    // 250 x 30 KB exceeds the ~6.6 MB of arguments that stopped runs at
    // ~220 calls under the former interrupt-check cap.
    await expect(
      run({
        hostFunctions: {
          host: {
            send: () => {
              calls += 1;
              return true;
            },
          },
        },
        limits: { maxBridgeRequests: 1000 },
        source: `
          const text = 'x'.repeat(30_000);
          for (let i = 0; i < 250; i++) await host.send({ i, text });
          return 'done';
        `,
      }),
    ).resolves.toEqual({ status: 'completed', value: 'done' });
    expect(calls).toBe(250);
  });

  it('gives each continuation resume a fresh CPU budget', async () => {
    const cpuTimeoutMs = 600;
    const steps = 8;
    // Size each step so the final invocation, which replays every step, uses
    // about 40% of the budget while all invocations together use about 220%.
    const iterationsPerStep = Math.round(
      ((await measureSpinIterationsPerMs()) * cpuTimeoutMs * 0.4) / steps,
    );
    // Invocation k replays k - 1 steps and runs one new step; the last resume
    // replays all of them.
    const executedSteps = (steps * (steps + 1)) / 2 + steps;

    // The same total work in one invocation exceeds the budget.
    await expect(
      run({
        limits: { cpuTimeoutMs, timeoutMs: 30_000 },
        source: `${spin(iterationsPerStep * executedSteps)} return 'done';`,
      }),
    ).rejects.toBeInstanceOf(RunCpuTimeoutError);

    const checkpoint = vi.fn(() => {
      const context = getHostFunctionContext();
      if (context.resume === undefined) {
        return context.interrupt(null);
      }
      return context.resume.resolution;
    });
    const input: RunInput<string> = {
      hostFunctions: { tools: { checkpoint } },
      limits: { cpuTimeoutMs, timeoutMs: 30_000 },
      source: `
        for (let step = 0; step < ${steps}; step++) {
          ${spin(iterationsPerStep)}
          await tools.checkpoint(step);
        }
        return 'done';
      `,
    };
    const runner = createRunner({ continuationSecret: 'x'.repeat(48) });
    let result = await runner.run(input);
    let invocations = 1;
    while (result.status === 'interrupted') {
      result = await runner.run({
        ...input,
        continuation: result.continuation,
        resolutions: result.interruptions.map(interruption => ({
          interruptionId: interruption.id,
          value: true,
        })),
      });
      invocations += 1;
    }
    expect(result).toEqual({ status: 'completed', value: 'done' });
    expect(invocations).toBe(steps + 1);
  });
});
