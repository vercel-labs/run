import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../run.js';
import { setRuntimeWorkerFactoryForTest } from './manager.js';

describe('manager protocol state machine', () => {
  afterEach(() => setRuntimeWorkerFactoryForTest(undefined));

  it.each([
    {
      message: /ready without a result/u,
      messages: (invocationId: string) => [{ invocationId, type: 'ready' }],
      name: 'ready before result',
    },
    {
      message: /duplicate result/u,
      messages: (invocationId: string) => [
        { invocationId, success: true, type: 'result', valueJson: '[1]' },
        { invocationId, success: true, type: 'result', valueJson: '[2]' },
      ],
      name: 'duplicate result',
    },
    {
      message: /invocationId mismatch/u,
      messages: () => [
        {
          invocationId: 'stale-run',
          success: true,
          type: 'result',
          valueJson: '[1]',
        },
      ],
      name: 'wrong invocation',
    },
    {
      message: /bridge-idle count mismatch/u,
      messages: (invocationId: string) => [
        { invocationId, requestCount: 1, type: 'bridge-idle' },
      ],
      name: 'wrong idle count',
    },
  ])('rejects $name', async ({ messages, message }) => {
    setRuntimeWorkerFactoryForTest(
      () => new FakeWorker(messages) as unknown as Worker,
    );
    await expect(run({ source: 'return 1;' })).rejects.toMatchObject({
      code: 'RUN_PROTOCOL_ERROR',
      message: expect.stringMatching(message),
    });
    await expectCleanRun();
  });

  it('rejects binding traffic after a terminal result without dispatch', async () => {
    const binding = vi.fn(() => 'effect');
    setRuntimeWorkerFactoryForTest(
      () =>
        new FakeWorker(invocationId => [
          { invocationId, success: true, type: 'result', valueJson: '[1]' },
          {
            bindingName: 'tools.effect',
            inputJson: '[[]]',
            invocationId,
            requestId: `${invocationId}:bridge-1`,
            type: 'binding-request',
          },
        ]) as unknown as Worker,
    );
    await expect(
      run({ bindings: { tools: { effect: binding } }, source: 'return 1;' }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    expect(binding).not.toHaveBeenCalled();
    await expectCleanRun();
  });

  it.each([
    {
      argument: new Error('injected worker failure'),
      event: 'error' as const,
      message: 'injected worker failure',
      name: 'worker error',
    },
    {
      argument: 17,
      event: 'exit' as const,
      message:
        'JavaScript runtime worker exited before completion with code 17.',
      name: 'worker exit',
    },
  ])(
    'settles once and recovers after $name',
    async ({ event, argument, message }) => {
      setRuntimeWorkerFactoryForTest(
        () => new TerminalWorker(event, argument) as unknown as Worker,
      );
      await expect(run({ source: 'return 1;' })).rejects.toThrow(message);
      await expectCleanRun();
    },
  );
});

async function expectCleanRun(): Promise<void> {
  setRuntimeWorkerFactoryForTest(
    () =>
      new FakeWorker(invocationId => [
        { invocationId, success: true, type: 'result', valueJson: '[1]' },
        { invocationId, type: 'ready' },
      ]) as unknown as Worker,
  );
  await expect(run({ source: 'return 1;' })).resolves.toEqual({
    status: 'completed',
    value: 1,
  });
}

class FakeWorker extends EventEmitter {
  readonly #messages: (invocationId: string) => Record<string, unknown>[];

  constructor(messages: (invocationId: string) => Record<string, unknown>[]) {
    super();
    this.#messages = messages;
  }

  postMessage(value: unknown): void {
    const message = value as { type?: string; invocationId?: string };
    if (message.type !== 'run' || message.invocationId === undefined) {
      return;
    }
    queueMicrotask(() => {
      for (const response of this.#messages(message.invocationId!)) {
        this.emit('message', response);
      }
    });
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  async terminate(): Promise<number> {
    this.emit('exit', 0);
    return 0;
  }
}

class TerminalWorker extends EventEmitter {
  constructor(
    private readonly event: 'error' | 'exit',
    private readonly argument: Error | number,
  ) {
    super();
  }

  postMessage(): void {
    queueMicrotask(() => this.emit(this.event, this.argument));
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  async terminate(): Promise<number> {
    return 0;
  }
}
