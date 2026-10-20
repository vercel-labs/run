import { Buffer } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RunCpuTimeoutError,
  RunTimeoutError,
  createRunner,
  getHostFunctionContext,
  run,
} from './index.js';
import type { RunInput } from './index.js';
import { setRuntimeWorkerFactoryForTest } from './runtime/manager.js';
import { INLINE_RUN_WORKER_SOURCE } from './runtime/worker-source.js';
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
const GUEST_WORK_AFTER_WAIT = spin(10_000);

// Run the actual bundled worker, QuickJS, bridges, and clock accounting. Only
// the worker's monotonic time source is controlled; wall deadlines stay real.
// Main-thread fake timers cannot control a separate worker's performance.now().
function useWorkerClock({
  msPerInterrupt = 1,
  interruptBurst = 1,
  asyncWaitMs = 0,
  syncWaitMs = 0,
} = {}) {
  // Virtual milliseconds, interrupt checks, and whether Atomics.wait is active.
  const state = new Int32Array(
    new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT),
  );
  const source = `
    import { workerData as cpuTestData, parentPort as cpuTestPort } from 'node:worker_threads';
    {
      const state = new Int32Array(cpuTestData);
      Object.defineProperty(performance, 'now', {
        value: () => Atomics.load(state, 0),
      });
      cpuTestPort.on('message', message => {
        // Message callbacks run after guest execution has yielded, before the
        // runtime measures the guest jobs resumed by this response.
        if (message.type === 'bridge-response') {
          Atomics.add(state, 0, ${asyncWaitMs});
        }
      });
      const wait = Atomics.wait;
      Atomics.wait = (...args) => {
        Atomics.store(state, 2, 1);
        try {
          return wait(...args);
        } finally {
          Atomics.add(state, 0, ${syncWaitMs});
          Atomics.store(state, 2, 0);
        }
      };
      const instantiate = WebAssembly.instantiate;
      WebAssembly.instantiate = (module, imports) => {
        const interrupt = imports.env.host_interrupt;
        if (typeof interrupt !== 'function') {
          throw new Error('QuickJS interrupt hook is missing');
        }
        let firstCheck = true;
        imports.env.host_interrupt = () => {
          // A burst exercises the former interrupt-count cap without burning
          // millions of guest instructions. Every check calls the real handler.
          const checks = firstCheck ? ${interruptBurst} : 1;
          firstCheck = false;
          for (let i = 0; i < checks; i++) {
            Atomics.add(state, 0, ${msPerInterrupt});
            Atomics.add(state, 1, 1);
            if (interrupt()) return 1;
          }
          return 0;
        };
        return instantiate(module, imports);
      };
    }
    ${INLINE_RUN_WORKER_SOURCE}
  `;
  setRuntimeWorkerFactoryForTest(() =>
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? new Worker(
          new URL(
            `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
          ),
          { execArgv: [], workerData: state.buffer },
        )
      : new Worker(source, {
          eval: true,
          execArgv: [],
          workerData: state.buffer,
        }),
  );
  return {
    checks: () => Atomics.load(state, 1),
    // Hold the host response until the worker enters its excluded wait. This
    // handshake avoids relying on thread scheduling or a sleep to reach it.
    waitUntilBlocked: async () => {
      await vi.waitFor(() => expect(Atomics.load(state, 2)).toBe(1), {
        interval: 1,
        timeout: 5000,
      });
    },
  };
}

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

describe('cpuTimeoutMs', () => {
  afterEach(() => {
    setRuntimeWorkerFactoryForTest(undefined);
  });
  it('defaults to 10 seconds, below the wall-clock timeout', () => {
    const options = normalizeOptions({});
    expect(options.cpuTimeoutMs).toBe(10_000);
    expect(options.cpuTimeoutMs).toBeLessThan(options.timeoutMs);
  });

  it('stops a busy loop with RUN_CPU_TIMEOUT under the default limits', async () => {
    useWorkerClock({ msPerInterrupt: 1000 });
    // Advance the worker clock through the default budget without waiting ten
    // real seconds. The real-clock test below still checks elapsed enforcement.
    const { error } = await elapsed(() => run({ source: 'while (true) {}' }));
    expect(error).toBeInstanceOf(RunCpuTimeoutError);
    expect(error).toMatchObject({
      code: 'RUN_CPU_TIMEOUT',
      details: { cpuTimeoutMs: 10_000 },
    });
  });

  it('does not let a pending interruption hide RUN_CPU_TIMEOUT', async () => {
    const runner = createRunner({ continuationSecret: 'x'.repeat(48) });
    const pause = vi.fn(() => getHostFunctionContext().interrupt('approval'));
    // One call interrupts while a concurrent call resolves and resumes the
    // guest, which never goes idle again, so the interruption is still
    // pending when the CPU limit trips.
    await expect(
      runner.run({
        hostFunctions: { tools: { pause, tick: () => 1 } },
        limits: { cpuTimeoutMs: 200, timeoutMs: 10_000 },
        source:
          'await Promise.race([tools.pause(), tools.tick()]); while (true) {}',
      }),
    ).rejects.toMatchObject({ code: 'RUN_CPU_TIMEOUT' });
    expect(pause).toHaveBeenCalledTimes(1);
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

  it('allows more than 10,000 interrupt checks within the CPU budget', async () => {
    const clock = useWorkerClock({ interruptBurst: 10_001, msPerInterrupt: 0 });
    await expect(
      run({ source: `${GUEST_WORK_AFTER_WAIT} return 'done';` }),
    ).resolves.toEqual({ status: 'completed', value: 'done' });
    expect(clock.checks()).toBeGreaterThan(10_000);
  });

  it('does not count time awaiting asynchronous host functions', async () => {
    useWorkerClock({ asyncWaitMs: 300 });
    await expect(
      run({
        hostFunctions: {
          tools: { sleep: (ms: number) => Promise.resolve(ms) },
        },
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
    const clock = useWorkerClock({ syncWaitMs: 300 });
    const runner = createRunner({
      limits: { cpuTimeoutMs: 150, timeoutMs: 5000 },
      syncHostFunctions: {
        tools: {
          sleep: async (ms: number) => {
            await clock.waitUntilBlocked();
            return ms;
          },
        },
      },
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
    const clock = useWorkerClock({ syncWaitMs: 300 });
    const load = vi.fn(async (specifier: string) => {
      await clock.waitUntilBlocked();
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

  it.each([
    ['asynchronous host functions', 'await tools.wait();'],
    ['synchronous host functions', 'sync.wait();'],
    ['module loaders', "await import('./value.js');"],
  ])('counts guest work after waiting on %s', async (_name, waitSource) => {
    const clock = useWorkerClock({ asyncWaitMs: 300, syncWaitMs: 300 });
    const runner = createRunner({
      syncHostFunctions: {
        sync: { wait: () => clock.waitUntilBlocked() },
      },
    });
    await expect(
      runner.run({
        hostFunctions: { tools: { wait: () => Promise.resolve(1) } },
        limits: { cpuTimeoutMs: 150, timeoutMs: 5000 },
        moduleLoader: {
          load: async () => {
            await clock.waitUntilBlocked();
            return 'export const value = 1;';
          },
        },
        source: `${waitSource} while (true) {}`,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_CPU_TIMEOUT',
      details: { cpuTimeoutMs: 150 },
    });
  });

  it('completes many host calls with large arguments (#76)', async () => {
    useWorkerClock({ msPerInterrupt: 0 });
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
    useWorkerClock();
    const cpuTimeoutMs = 600;
    const steps = 8;
    // Each interrupt consumes one virtual millisecond, independent of machine
    // speed. The combined work must fail while every replay/resume must fit.
    const iterationsPerStep = 100_000;
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

  it('still enforces the CPU budget after a continuation resume', async () => {
    useWorkerClock();
    const runner = createRunner({ continuationSecret: 'x'.repeat(48) });
    const input: RunInput<string> = {
      hostFunctions: {
        tools: {
          pause: () => {
            const context = getHostFunctionContext();
            return context.resume === undefined
              ? context.interrupt(null)
              : context.resume.resolution;
          },
        },
      },
      limits: { cpuTimeoutMs: 150, timeoutMs: 5000 },
      source: 'await tools.pause(); while (true) {}',
    };
    const result = await runner.run(input);
    expect(result.status).toBe('interrupted');
    if (result.status !== 'interrupted') {
      throw new Error('Expected a continuation before the busy loop.');
    }
    await expect(
      runner.run({
        ...input,
        continuation: result.continuation,
        resolutions: result.interruptions.map(interruption => ({
          interruptionId: interruption.id,
          value: true,
        })),
      }),
    ).rejects.toMatchObject({
      code: 'RUN_CPU_TIMEOUT',
      details: { cpuTimeoutMs: 150 },
    });
  });
});
