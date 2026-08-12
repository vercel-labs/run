import { Buffer } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { createPromiseWithResolvers } from '../utils/promise-with-resolvers.js';
import type { MainToWorkerMessage } from './protocol.js';
import { INLINE_RUN_WORKER_SOURCE } from './worker-source.js';

const createRunMessage = (
  invocationId: string,
  source: string,
): MainToWorkerMessage => ({
  determinism: {
    dateNowMs: 1_700_000_000_000,
    randomSeed: '00000000000000000000000000000001',
  },
  hostFunctionNamespaces: ['tools'],
  invocationId,
  options: {
    executionTimeoutMs: 950,
    maxConsoleOutputBytes: 64 * 1024,
    maxHostFunctionInputBytes: 1024 * 1024,
    maxResultBytes: 1024 * 1024,
    maxStackSizeBytes: 2 * 1024 * 1024,
    memoryLimitBytes: 64 * 1024 * 1024,
    timeoutMs: 1000,
  },
  source,
  type: 'run',
});

it('reports message failures and ignores late messages without crashing', async () => {
  const workerUrl = new URL(
    `data:text/javascript;base64,${Buffer.from(INLINE_RUN_WORKER_SOURCE).toString('base64')}`,
  );
  const worker = new Worker(workerUrl, { execArgv: [] });
  const postToWorker = (message: MainToWorkerMessage): void => {
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- Node.js Worker has no targetOrigin parameter.
    worker.postMessage(message);
  };
  const results: {
    error?: { message?: string };
    invocationId: string;
    success: boolean;
    type: 'result';
    valueJson?: string;
  }[] = [];

  try {
    const completed = createPromiseWithResolvers<null>();
    worker.on('error', completed.reject);
    worker.on('message', (value: unknown) => {
      const message = value as {
        invocationId?: string;
        requestId?: string;
        type?: string;
      };
      if (
        message.type === 'host-function-request' &&
        message.invocationId !== undefined &&
        message.requestId !== undefined
      ) {
        postToWorker({
          dateNowMs: 1_700_000_000_001,
          invocationId:
            message.invocationId === 'run-failure'
              ? 'wrong-invocation'
              : message.invocationId,
          requestId: message.requestId,
          success: true,
          type: 'bridge-response',
          valueJson: '[null]',
        });
        return;
      }
      if (message.type === 'result') {
        results.push(value as (typeof results)[number]);
        return;
      }
      if (message.type !== 'ready') {
        return;
      }
      if (message.invocationId === 'run-failure') {
        postToWorker({
          invocationId: 'run-failure',
          type: 'cancel',
        });
        postToWorker({
          dateNowMs: 1_700_000_000_002,
          invocationId: 'run-failure',
          requestId: 'run-failure:bridge-1',
          success: true,
          type: 'bridge-response',
          valueJson: '[null]',
        });
        postToWorker(createRunMessage('run-next', 'return 42;'));
        return;
      }
      if (message.invocationId === 'run-next') {
        completed.resolve(null);
      }
    });
    postToWorker(
      createRunMessage(
        'run-failure',
        `
          return await tools.echo();
        `,
      ),
    );
    await completed.promise;

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      error: {
        message:
          'Bridge response invocationId mismatch for request run-failure:bridge-1: expected run-failure, received wrong-invocation.',
      },
      invocationId: 'run-failure',
      success: false,
    });
    expect(results[1]).toMatchObject({
      invocationId: 'run-next',
      success: true,
    });
  } finally {
    await worker.terminate();
  }
});
