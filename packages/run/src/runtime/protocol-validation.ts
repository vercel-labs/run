import { Buffer } from 'node:buffer';
import { RunProtocolError } from '../errors.js';
import type { SerializableError } from '../types.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol.js';

const invalidMessage = (kind: string): RunProtocolError =>
  new RunProtocolError(`Invalid ${kind} worker protocol message.`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: string[],
): void => {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = expected.toSorted();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw invalidMessage('object shape');
  }
};

const isSerializableError = (value: unknown): value is SerializableError => {
  if (!isRecord(value)) {
    return false;
  }
  const allowed = new Set(['code', 'details', 'message', 'name', 'stack']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    return false;
  }
  return (
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    (value.stack === undefined || typeof value.stack === 'string') &&
    (value.code === undefined || typeof value.code === 'string')
  );
};

const isRunOptions = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  try {
    assertExactKeys(value, [
      'executionTimeoutMs',
      'maxConsoleOutputBytes',
      'maxHostFunctionInputBytes',
      'maxResultBytes',
      'maxStackSizeBytes',
      'memoryLimitBytes',
      'timeoutMs',
    ]);
  } catch {
    return false;
  }
  return Object.values(value).every(
    item => Number.isSafeInteger(item) && (item as number) > 0,
  );
};

const isDeterminism = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  try {
    assertExactKeys(value, ['dateNowMs', 'randomSeed']);
  } catch {
    return false;
  }
  return (
    isTimestamp(value.dateNowMs) &&
    typeof value.randomSeed === 'string' &&
    /^[0-9a-f]{32}$/u.test(value.randomSeed)
  );
};

const assertReady = (value: Record<string, unknown>): void => {
  assertExactKeys(value, ['invocationId', 'type']);
  if (!isIdentifier(value.invocationId)) {
    throw invalidMessage('ready');
  }
};

const assertResult = (value: Record<string, unknown>): void => {
  if (value.success === true) {
    assertExactKeys(value, ['invocationId', 'success', 'type', 'valueJson']);
    if (
      !isIdentifier(value.invocationId) ||
      typeof value.valueJson !== 'string' ||
      value.valueJson.length === 0
    ) {
      throw invalidMessage('result');
    }
    return;
  }
  assertExactKeys(value, ['error', 'invocationId', 'success', 'type']);
  if (
    value.success !== false ||
    !isIdentifier(value.invocationId) ||
    !isSerializableError(value.error)
  ) {
    throw invalidMessage('result');
  }
};

const assertBridgeIdle = (value: Record<string, unknown>): void => {
  assertExactKeys(value, ['invocationId', 'requestCount', 'type']);
  if (
    !isIdentifier(value.invocationId) ||
    !Number.isSafeInteger(value.requestCount) ||
    (value.requestCount as number) < 0
  ) {
    throw invalidMessage('bridge-idle');
  }
};

const assertHostFunctionRequest = (value: Record<string, unknown>): void => {
  assertExactKeys(value, [
    'hostFunctionName',
    'inputJson',
    'invocationId',
    'requestId',
    'type',
  ]);
  if (
    !isIdentifier(value.invocationId) ||
    !isIdentifier(value.requestId) ||
    typeof value.hostFunctionName !== 'string' ||
    value.hostFunctionName.length === 0 ||
    Buffer.byteLength(value.hostFunctionName) > 1024 ||
    typeof value.inputJson !== 'string' ||
    value.inputJson.length === 0
  ) {
    throw invalidMessage('host-function-request');
  }
};

const assertBridgeResponse = (value: Record<string, unknown>): void => {
  const common =
    isIdentifier(value.invocationId) &&
    isIdentifier(value.requestId) &&
    typeof value.success === 'boolean' &&
    isTimestamp(value.dateNowMs);
  if (value.success === true) {
    assertExactKeys(value, [
      'dateNowMs',
      'invocationId',
      'requestId',
      'success',
      'type',
      'valueJson',
    ]);
    if (
      !common ||
      typeof value.valueJson !== 'string' ||
      value.valueJson.length === 0
    ) {
      throw invalidMessage('bridge-response');
    }
    return;
  }
  assertExactKeys(value, [
    'dateNowMs',
    'error',
    'invocationId',
    'requestId',
    'success',
    'type',
  ]);
  if (!common || !isSerializableError(value.error)) {
    throw invalidMessage('bridge-response');
  }
};

type AssertMainToWorkerMessage = (
  value: unknown,
) => asserts value is MainToWorkerMessage;

export const assertMainToWorkerMessage: AssertMainToWorkerMessage = value => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw invalidMessage('main-to-worker');
  }
  if (value.type === 'run') {
    assertExactKeys(value, [
      'determinism',
      'hostFunctionNamespaces',
      'invocationId',
      'options',
      'source',
      'type',
    ]);
    if (
      !isIdentifier(value.invocationId) ||
      typeof value.source !== 'string' ||
      !Array.isArray(value.hostFunctionNamespaces) ||
      value.hostFunctionNamespaces.some(item => !isIdentifier(item)) ||
      new Set(value.hostFunctionNamespaces).size !==
        value.hostFunctionNamespaces.length ||
      !isDeterminism(value.determinism) ||
      !isRunOptions(value.options)
    ) {
      throw invalidMessage('run');
    }
    return;
  }
  if (value.type === 'bridge-response') {
    assertBridgeResponse(value);
    return;
  }
  if (value.type === 'cancel') {
    assertExactKeys(value, ['invocationId', 'type']);
    if (!isIdentifier(value.invocationId)) {
      throw invalidMessage('cancel');
    }
    return;
  }
  throw invalidMessage('main-to-worker');
};

type AssertWorkerToMainMessage = (
  value: unknown,
) => asserts value is WorkerToMainMessage;

export const assertWorkerToMainMessage: AssertWorkerToMainMessage = value => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw invalidMessage('worker-to-main');
  }
  if (value.type === 'host-function-request') {
    assertHostFunctionRequest(value);
    return;
  }
  if (value.type === 'bridge-idle') {
    assertBridgeIdle(value);
    return;
  }
  if (value.type === 'result') {
    assertResult(value);
    return;
  }
  if (value.type === 'ready') {
    assertReady(value);
    return;
  }
  throw invalidMessage('worker-to-main');
};
