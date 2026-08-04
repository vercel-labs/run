import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../run.js';
import { setRuntimeWorkerFactoryForTest } from './manager.js';

type WorkerListener = (value: unknown) => void;
type WorkerEmit = (event: string, value: unknown) => void;

const createWorkerDouble = ({
  postMessage,
  terminate,
}: {
  postMessage: (value: unknown, emit: WorkerEmit) => void;
  terminate?: (emit: WorkerEmit) => void;
}): Worker => {
  const listeners = new Map<string, Set<WorkerListener>>();
  const emit: WorkerEmit = (event, value) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(value);
    }
  };
  const worker = {
    off(event: string, listener: WorkerListener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    on(event: string, listener: WorkerListener) {
      const eventListeners = listeners.get(event) ?? new Set<WorkerListener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return this;
    },
    once(event: string, listener: WorkerListener) {
      const wrapped: WorkerListener = value => {
        listeners.get(event)?.delete(wrapped);
        listener(value);
      };
      return this.on(event, wrapped);
    },
    postMessage(value: unknown) {
      postMessage(value, emit);
    },
    ref() {
      return this;
    },
    removeAllListeners(event?: string) {
      if (event === undefined) {
        listeners.clear();
      } else {
        listeners.delete(event);
      }
      return this;
    },
    terminate() {
      terminate?.(emit);
      return Promise.resolve(0);
    },
    unref() {
      return this;
    },
  };
  return worker as unknown as Worker;
};

const createProtocolWorker = (
  messages: (invocationId: string) => Record<string, unknown>[],
): Worker =>
  createWorkerDouble({
    postMessage: (value, emit) => {
      const message = value as { type?: string; invocationId?: string };
      const { invocationId } = message;
      if (message.type !== 'run' || invocationId === undefined) {
        return;
      }
      queueMicrotask(() => {
        for (const response of messages(invocationId)) {
          emit('message', response);
        }
      });
    },
    terminate: emit => emit('exit', 0),
  });

const createTerminalWorker = (
  event: 'error' | 'exit',
  argument: Error | number,
): Worker =>
  createWorkerDouble({
    postMessage: (_value, emit) => {
      queueMicrotask(() => emit(event, argument));
    },
  });

const expectCleanRun = async (): Promise<void> => {
  setRuntimeWorkerFactoryForTest(() =>
    createProtocolWorker(invocationId => [
      { invocationId, success: true, type: 'result', valueJson: '[1]' },
      { invocationId, type: 'ready' },
    ]),
  );
  await expect(run({ source: 'return 1;' })).resolves.toEqual({
    status: 'completed',
    value: 1,
  });
};

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
    setRuntimeWorkerFactoryForTest(() => createProtocolWorker(messages));
    await expect(run({ source: 'return 1;' })).rejects.toMatchObject({
      code: 'RUN_PROTOCOL_ERROR',
      message: expect.stringMatching(message),
    });
    await expectCleanRun();
  });

  it('rejects binding traffic after a terminal result without dispatch', async () => {
    const binding = vi.fn(() => 'effect');
    setRuntimeWorkerFactoryForTest(() =>
      createProtocolWorker(invocationId => [
        { invocationId, success: true, type: 'result', valueJson: '[1]' },
        {
          bindingName: 'tools.effect',
          inputJson: '[[]]',
          invocationId,
          requestId: `${invocationId}:bridge-1`,
          type: 'binding-request',
        },
      ]),
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
      setRuntimeWorkerFactoryForTest(() =>
        createTerminalWorker(event, argument),
      );
      await expect(run({ source: 'return 1;' })).rejects.toThrow(message);
      await expectCleanRun();
    },
  );
});
