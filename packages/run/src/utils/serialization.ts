import { Buffer } from 'node:buffer';
import { RunError } from '../errors.js';
import { RUN_SERDE, deserializeRunValue, serializeRunValue } from './serde.js';

export { RUN_SERDE };

const getSerializationPath = (error: unknown): string => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'path' in error &&
    typeof error.path === 'string' &&
    error.path.length > 0
  ) {
    return ` at ${error.path}`;
  }
  return '';
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Parses a payload that has already been bounded with assertJsonPayloadSize.
 * Callers must enforce the appropriate boundary-specific limit before parsing.
 */
export const parseJsonPayload = (valueJson: string, label: string): unknown => {
  try {
    return deserializeRunValue(valueJson);
  } catch (error) {
    throw new RunError(
      `${label} is not valid ${RUN_SERDE} data: ${getErrorMessage(error)}`,
      'RUN_SERIALIZATION_ERROR',
    );
  }
};

export const assertJsonPayloadSize = (
  valueJson: string,
  maxBytes: number,
  label: string,
): void => {
  const bytes = Buffer.byteLength(valueJson);
  if (bytes > maxBytes) {
    throw new RunError(
      `${label} exceeds the ${maxBytes} byte size limit.`,
      'RUN_SERIALIZATION_ERROR',
      { bytes, maxBytes },
    );
  }
};

export const toJsonPayload = (
  value: unknown,
  maxBytes: number,
  label: string,
): string => {
  let encoded: string | undefined;
  try {
    encoded = serializeRunValue(value);
  } catch (error) {
    const path = getSerializationPath(error);
    throw new RunError(
      `${label} is not serializable${path}: ${getErrorMessage(error)}`,
      'RUN_SERIALIZATION_ERROR',
    );
  }

  if (encoded === undefined) {
    throw new RunError(
      `${label} is not serializable.`,
      'RUN_SERIALIZATION_ERROR',
    );
  }

  assertJsonPayloadSize(encoded, maxBytes, label);
  return encoded;
};

export const normalizeJsonPayload = (
  value: unknown,
  maxBytes: number,
  label: string,
): unknown => parseJsonPayload(toJsonPayload(value, maxBytes, label), label);
