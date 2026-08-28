import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHostFunctionContext } from '../host-function-context.js';
import { createRunner, run } from '../run.js';
import { createPromiseWithResolvers } from '../utils/promise-with-resolvers.js';
import { setRuntimeWorkerFactoryForTest } from './manager.js';

type WorkerListener = (value: unknown) => void;
type WorkerEmit = (event: string, value: unknown) => void;

function ThrowingSharedArrayBuffer(): never {
  throw new RangeError('allocation failed');
}

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
  afterEach(() => {
    setRuntimeWorkerFactoryForTest(undefined);
    vi.unstubAllGlobals();
  });

  it('omits the synchronous bridge for ordinary runs', async () => {
    let receivedSyncBridge: unknown = 'not-received';
    setRuntimeWorkerFactoryForTest(() =>
      createWorkerDouble({
        postMessage: (value, emit) => {
          const message = value as {
            invocationId?: string;
            syncBridge?: unknown;
            type?: string;
          };
          if (message.type !== 'run' || message.invocationId === undefined) {
            return;
          }
          receivedSyncBridge = message.syncBridge;
          queueMicrotask(() => {
            emit('message', {
              invocationId: message.invocationId,
              success: true,
              type: 'result',
              valueJson: '[1]',
            });
            emit('message', {
              invocationId: message.invocationId,
              type: 'ready',
            });
          });
        },
      }),
    );

    await expect(run({ source: 'return 1;' })).resolves.toEqual({
      status: 'completed',
      value: 1,
    });
    expect(receivedSyncBridge).toBeUndefined();
  });

  it('allocates the synchronous bridge before acquiring a worker', async () => {
    const workerFactory = vi.fn(() =>
      createProtocolWorker(invocationId => [
        { invocationId, success: true, type: 'result', valueJson: '[1]' },
        { invocationId, type: 'ready' },
      ]),
    );
    setRuntimeWorkerFactoryForTest(workerFactory);
    vi.stubGlobal('SharedArrayBuffer', ThrowingSharedArrayBuffer);

    await expect(
      createRunner({
        syncHostFunctions: { values: { read: () => 1 } },
      }).run({ source: 'return values.read();' }),
    ).rejects.toThrow('allocation failed');
    expect(workerFactory).not.toHaveBeenCalled();
  });

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

  it('rejects host function traffic after a terminal result without dispatch', async () => {
    const hostFunction = vi.fn(() => 'effect');
    setRuntimeWorkerFactoryForTest(() =>
      createProtocolWorker(invocationId => [
        { invocationId, success: true, type: 'result', valueJson: '[1]' },
        {
          hostFunctionName: 'tools.effect',
          inputJson: '[[]]',
          invocationId,
          requestId: `${invocationId}:bridge-1`,
          requestIndex: 1,
          type: 'host-function-request',
        },
      ]),
    );
    await expect(
      run({
        hostFunctions: { tools: { effect: hostFunction } },
        source: 'return 1;',
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    expect(hostFunction).not.toHaveBeenCalled();
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

  it('preserves an encoded interruption when the worker fails after its result', async () => {
    const encodeStarted = createPromiseWithResolvers<null>();
    const finishEncode = createPromiseWithResolvers<null>();
    let emitWorker: WorkerEmit | undefined;
    const postedMessages: unknown[] = [];
    setRuntimeWorkerFactoryForTest(() =>
      createWorkerDouble({
        postMessage: (value, emit) => {
          emitWorker = emit;
          postedMessages.push(value);
          const message = value as {
            invocationId?: string;
            type?: string;
          };
          if (message.type !== 'run' || message.invocationId === undefined) {
            return;
          }
          queueMicrotask(() => {
            emit('message', {
              hostFunctionName: 'tools.pause',
              inputJson: '[[]]',
              invocationId: message.invocationId,
              requestId: `${message.invocationId}:bridge-1`,
              requestIndex: 1,
              type: 'host-function-request',
            });
            emit('message', {
              invocationId: message.invocationId,
              requestCount: 1,
              type: 'bridge-idle',
            });
          });
        },
      }),
    );
    const runner = createRunner({
      continuationCodec: {
        decode: () => {
          throw new Error('not used');
        },
        async encode() {
          encodeStarted.resolve(null);
          await finishEncode.promise;
          return 'encoded-interruption';
        },
      },
    });

    const result = runner.run({
      hostFunctions: {
        tools: {
          pause: () => getHostFunctionContext().interrupt({ kind: 'pause' }),
        },
      },
      source: 'return await tools.pause();',
    });
    await encodeStarted.promise;
    const { invocationId } = postedMessages.find(
      value => (value as { type?: string }).type === 'run',
    ) as { invocationId: string };
    emitWorker?.('message', {
      invocationId,
      success: true,
      type: 'result',
      valueJson: '[null]',
    });
    finishEncode.resolve(null);
    const settlementTurn = createPromiseWithResolvers<null>();
    setImmediate(() => settlementTurn.resolve(null));
    await settlementTurn.promise;
    expect(postedMessages).not.toContainEqual({
      invocationId,
      type: 'cancel',
    });
    emitWorker?.('error', new Error('late worker failure'));

    await expect(result).resolves.toMatchObject({
      continuation: 'encoded-interruption',
      status: 'interrupted',
    });
  });
});
