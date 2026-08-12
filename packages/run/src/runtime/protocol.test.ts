import { describe, expect, it } from 'vitest';
import {
  assertMainToWorkerMessage,
  assertWorkerToMainMessage,
} from './protocol-validation.js';

const WORKER_OPTIONS = {
  executionTimeoutMs: 950,
  maxConsoleOutputBytes: 64 * 1024,
  maxHostFunctionInputBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxStackSizeBytes: 2 * 1024 * 1024,
  memoryLimitBytes: 64 * 1024 * 1024,
  timeoutMs: 1000,
};

const DETERMINISM = {
  dateNowMs: 1_700_000_000_000,
  randomSeed: '00000000000000000000000000000001',
};

const createRunMessage = (invocationId: string) => ({
  determinism: DETERMINISM,
  hostFunctionNamespaces: ['tools'],
  invocationId,
  options: WORKER_OPTIONS,
  source: 'return await tools.echo({ value: 1 });',
  type: 'run',
});

const requireEntry = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing generated value at index ${index}.`);
  }
  return value;
};

describe('worker protocol hardening', () => {
  it.each([
    null,
    {},
    { type: 'unknown' },
    { ...createRunMessage('invocation-a'), extra: true },
    { ...createRunMessage('invocation-a'), invocationId: '' },
    { extra: true, invocationId: '', type: 'cancel' },
    { invocationId: '', type: 'cancel' },
    {
      ...createRunMessage('invocation-a'),
      hostFunctionNamespaces: ['tools', 'tools'],
    },
    {
      ...createRunMessage('invocation-a'),
      options: { ...WORKER_OPTIONS, timeoutMs: 0 },
    },
    {
      invocationId: 'invocation-a',
      requestId: 'request-a',
      success: true,
      type: 'bridge-response',
      valueJson: '',
    },
  ])('rejects malformed main-to-worker messages %#', value => {
    expect(() => assertMainToWorkerMessage(value)).toThrowError(
      expect.objectContaining({ code: 'RUN_PROTOCOL_ERROR' }),
    );
  });

  it.each([
    null,
    {},
    { type: 'unknown' },
    { extra: true, invocationId: 'run-1', type: 'ready' },
    { invocationId: 'run-1', requestCount: -1, type: 'bridge-idle' },
    {
      hostFunctionName: '',
      inputJson: '[]',
      invocationId: 'run-1',
      requestId: 'request-1',
      type: 'host-function-request',
    },
    { invocationId: 'run-1', success: true, type: 'result' },
    {
      error: { message: 'failure', name: 'Error', unexpected: true },
      invocationId: 'run-1',
      success: false,
      type: 'result',
    },
  ])('rejects malformed worker-to-main messages %#', value => {
    expect(() => assertWorkerToMainMessage(value)).toThrowError(
      expect.objectContaining({ code: 'RUN_PROTOCOL_ERROR' }),
    );
  });

  it('fails closed for 10,000 generated malformed protocol values', () => {
    let randomState = 305_419_896;
    const next = (): number => {
      randomState = (randomState * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return randomState;
    };
    const generatedValue = (depth: number): unknown => {
      const choice = next() % (depth > 2 ? 5 : 8);
      if (choice === 0) {
        return null;
      }
      if (choice === 1) {
        return next();
      }
      if (choice === 2) {
        return `value-${next()}`;
      }
      if (choice === 3) {
        return next() % 2 === 1;
      }
      if (choice === 4) {
        return undefined;
      }
      if (choice === 5) {
        return Array.from({ length: next() % 4 }, () =>
          generatedValue(depth + 1),
        );
      }
      const result: Record<string, unknown> = {};
      for (let item = 0; item < next() % 5; item += 1) {
        result[`key-${next() % 12}`] = generatedValue(depth + 1);
      }
      return result;
    };
    const validators: ((value: unknown) => void)[] = [
      value => assertMainToWorkerMessage(value),
      value => assertWorkerToMainMessage(value),
    ];

    for (let index = 0; index < 10_000; index += 1) {
      const value = generatedValue(0);
      for (const validate of validators) {
        try {
          validate(value);
        } catch (error) {
          expect(error).toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
        }
      }
    }
  });

  it('rejects every generated mutation of known-valid messages', () => {
    let randomState = 1_374_775_901;
    const next = (): number => {
      randomState = (randomState * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return randomState;
    };
    const validMessages = [
      { direction: 'main', value: createRunMessage('run-a') },
      { direction: 'main', value: { invocationId: 'run-a', type: 'cancel' } },
      {
        direction: 'main',
        value: {
          dateNowMs: DETERMINISM.dateNowMs,
          invocationId: 'run-a',
          requestId: 'request-a',
          success: true,
          type: 'bridge-response',
          valueJson: 'null',
        },
      },
      { direction: 'worker', value: { invocationId: 'run-a', type: 'ready' } },
      {
        direction: 'worker',
        value: {
          hostFunctionName: 'tools.echo',
          inputJson: 'null',
          invocationId: 'run-a',
          requestId: 'request-a',
          type: 'host-function-request',
        },
      },
      {
        direction: 'worker',
        value: {
          invocationId: 'run-a',
          success: true,
          type: 'result',
          valueJson: 'null',
        },
      },
    ] as const;

    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const candidate = requireEntry(
        validMessages,
        next() % validMessages.length,
      );
      let mutation = structuredClone(candidate.value) as Record<
        string,
        unknown
      >;
      if (next() % 2 === 0) {
        const keys = Object.keys(mutation);
        const removedKey = requireEntry(keys, next() % keys.length);
        mutation = Object.fromEntries(
          Object.entries(mutation).filter(([key]) => key !== removedKey),
        );
      } else {
        mutation[`unexpected-${next()}`] = true;
      }
      const validate =
        candidate.direction === 'main'
          ? assertMainToWorkerMessage
          : assertWorkerToMainMessage;
      expect(
        () => validate(mutation),
        `seed iteration ${iteration}`,
      ).toThrowError(expect.objectContaining({ code: 'RUN_PROTOCOL_ERROR' }));
    }
  });
});
