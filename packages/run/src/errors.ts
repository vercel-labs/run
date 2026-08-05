import { Buffer } from 'node:buffer';
import type { SerializableError } from './types.js';
import { parseJson } from './utils/parse-json.js';
import { RunAbortedError } from './errors/run-aborted-error.js';
import { RunBindingError } from './errors/run-binding-error.js';
import { RunBridgeLimitError } from './errors/run-bridge-limit-error.js';
import { RunConcurrencyError } from './errors/run-concurrency-error.js';
import { RunDetachedBridgeRequestError } from './errors/run-detached-bridge-request-error.js';
import { RunError } from './errors/run-error.js';
import { RunProtocolError } from './errors/run-protocol-error.js';
import { RunSourceTooLargeError } from './errors/run-source-too-large-error.js';
import { RunTimeoutError } from './errors/run-timeout-error.js';

export {
  RunAbortedError,
  RunBindingError,
  RunBridgeLimitError,
  RunConcurrencyError,
  RunDetachedBridgeRequestError,
  RunError,
  RunProtocolError,
  RunSourceTooLargeError,
  RunTimeoutError,
};

export const MAX_SERIALIZED_ERROR_BYTES = 64 * 1024;
const MAX_ERROR_NAME_BYTES = 256;
const MAX_ERROR_MESSAGE_BYTES = 16 * 1024;
const MAX_ERROR_STACK_BYTES = 32 * 1024;
const MAX_ERROR_CODE_BYTES = 256;
const MAX_ERROR_DETAILS_BYTES = 16 * 1024;

const boundedString = (
  value: string,
  maxBytes: number,
  fallback: string,
): string => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  const suffix = '…[truncated]';
  const suffixBytes = Buffer.byteLength(suffix);
  return `${bytes.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString('utf8')}${suffix}`;
};

const sanitizeStack = (value: string): string =>
  boundedString(
    value
      .replaceAll(/data:text\/javascript;base64,[^\s)]+/gu, '<run-worker>')
      .replaceAll(/file:\/\/\/[^\s)]+/gu, '<internal>'),
    MAX_ERROR_STACK_BYTES,
    '',
  );

const sanitizeDetails = (value: unknown): unknown => {
  if (value === undefined) {
    return undefined;
  }
  try {
    const encoded = JSON.stringify(value);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded) > MAX_ERROR_DETAILS_BYTES
    ) {
      return undefined;
    }
    return parseJson(encoded);
  } catch {
    return undefined;
  }
};

const safeErrorProperty = (error: Error, property: string): unknown => {
  try {
    return (error as unknown as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
};

const safeToString = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return 'JavaScript runtime failed.';
  }
};

const compactError = (error: {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  details?: unknown;
}): SerializableError => ({
  message: error.message,
  name: error.name,
  ...(error.stack === undefined ? {} : { stack: error.stack }),
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(error.details === undefined ? {} : { details: error.details }),
});

const enforceSerializedErrorLimit = (
  error: SerializableError,
): SerializableError => {
  if (Buffer.byteLength(JSON.stringify(error)) <= MAX_SERIALIZED_ERROR_BYTES) {
    return error;
  }
  return {
    message: boundedString(
      error.message,
      MAX_ERROR_MESSAGE_BYTES,
      'JavaScript runtime failed.',
    ),
    name: boundedString(error.name, MAX_ERROR_NAME_BYTES, 'Error'),
    ...(error.code === undefined
      ? {}
      : { code: boundedString(error.code, MAX_ERROR_CODE_BYTES, 'RUN_ERROR') }),
  };
};

const restoreStack = (error: Error, serialized: SerializableError): void => {
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
};

/**
 * Converts an unknown thrown value into a worker-safe serializable shape.
 *
 * @internal
 */
export const serializeError = (error: unknown): SerializableError => {
  if (RunError.isInstance(error)) {
    const result = compactError({
      code: boundedString(error.code, MAX_ERROR_CODE_BYTES, 'RUN_ERROR'),
      message: boundedString(
        error.message,
        MAX_ERROR_MESSAGE_BYTES,
        'JavaScript runtime failed.',
      ),
      name: boundedString(error.name, MAX_ERROR_NAME_BYTES, 'RunError'),
    });
    const stack = safeErrorProperty(error, 'stack');
    if (typeof stack === 'string') {
      result.stack = sanitizeStack(stack);
    }
    const details = sanitizeDetails(safeErrorProperty(error, 'details'));
    if (details !== undefined) {
      result.details = details;
    }
    return enforceSerializedErrorLimit(result);
  }

  if (error instanceof Error) {
    const result = compactError({
      message: boundedString(
        error.message,
        MAX_ERROR_MESSAGE_BYTES,
        'JavaScript runtime failed.',
      ),
      name: boundedString(error.name, MAX_ERROR_NAME_BYTES, 'Error'),
    });
    const stack = safeErrorProperty(error, 'stack');
    if (typeof stack === 'string') {
      result.stack = sanitizeStack(stack);
    }
    const code = safeErrorProperty(error, 'code');
    if (typeof code === 'string') {
      result.code = boundedString(code, MAX_ERROR_CODE_BYTES, 'RUN_ERROR');
    }
    const details = sanitizeDetails(safeErrorProperty(error, 'details'));
    if (details !== undefined) {
      result.details = details;
    }
    return enforceSerializedErrorLimit(result);
  }

  return enforceSerializedErrorLimit({
    message: boundedString(
      safeToString(error),
      MAX_ERROR_MESSAGE_BYTES,
      'JavaScript runtime failed.',
    ),
    name: 'Error',
  });
};

/**
 * Converts host bridge failures into a sandbox-visible sanitized shape.
 *
 * This intentionally omits stack traces and diagnostic details. Full host
 * diagnostics remain on the host side.
 *
 * @internal
 */
export const serializeBridgeErrorForGuest = (
  error: unknown,
  context: 'binding' | 'bridge',
): SerializableError => {
  if (RunError.isInstance(error)) {
    return compactError({
      code: boundedString(error.code, MAX_ERROR_CODE_BYTES, 'RUN_ERROR'),
      message: boundedString(
        error.message,
        MAX_ERROR_MESSAGE_BYTES,
        'Host binding failed.',
      ),
      name: boundedString(error.name, MAX_ERROR_NAME_BYTES, 'RunError'),
    });
  }

  const fallback =
    context === 'binding'
      ? {
          code: 'RUN_HOST_BINDING_ERROR',
          message: 'Host binding failed.',
        }
      : {
          code: 'RUN_HOST_BRIDGE_ERROR',
          message: 'Host bridge request failed.',
        };

  return {
    code: fallback.code,
    message: fallback.message,
    name: 'Error',
  };
};

/**
 * Rehydrates a serialized worker error into an Error instance.
 *
 * @internal
 */
export const deserializeError = (error: SerializableError): Error => {
  if (error.code === 'RUN_TIMEOUT') {
    const details = error.details as { timeoutMs?: number } | undefined;
    const result = new RunTimeoutError(details?.timeoutMs ?? 0);
    restoreStack(result, error);
    return result;
  }

  if (error.code === 'RUN_ABORTED') {
    const result = new RunAbortedError();
    restoreStack(result, error);
    return result;
  }

  if (error.code === 'RUN_SOURCE_TOO_LARGE') {
    const details = error.details as
      | { bytes?: number; maxBytes?: number }
      | undefined;
    const result = new RunSourceTooLargeError(
      details?.bytes ?? 0,
      details?.maxBytes ?? 0,
    );
    restoreStack(result, error);
    return result;
  }

  if (error.code === 'RUN_BRIDGE_LIMIT') {
    const result = new RunBridgeLimitError(error.message, error.details);
    restoreStack(result, error);
    return result;
  }

  if (error.code === 'RUN_DETACHED_BRIDGE_REQUEST') {
    const result = new RunDetachedBridgeRequestError(
      error.message,
      error.details,
    );
    restoreStack(result, error);
    return result;
  }

  if (error.code === 'RUN_PROTOCOL_ERROR') {
    const result = new RunProtocolError(error.message, error.details);
    restoreStack(result, error);
    return result;
  }

  const result = new RunError(
    error.message,
    error.code ?? 'RUN_ERROR',
    error.details,
  );
  result.name = error.name;
  restoreStack(result, error);
  return result;
};
