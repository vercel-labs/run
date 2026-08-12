import type { NormalizedRunOptions, RunLimits } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_STACK_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONSOLE_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const DEFAULT_MAX_HOST_FUNCTION_ARGUMENTS_BYTES = 1024 * 1024;
const DEFAULT_MAX_HOST_FUNCTION_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BRIDGE_REQUESTS = 256;
const DEFAULT_MAX_IN_FLIGHT_BRIDGE_REQUESTS = 32;
const DEFAULT_MAX_CONTINUATION_BYTES = 32 * 1024 * 1024;
const MAX_LIMIT_VALUE = 2_147_483_647;

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  path: string,
  max = MAX_LIMIT_VALUE,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${path} must be a positive integer.`);
  }
  if (resolved > max) {
    throw new TypeError(`${path} must be at most ${max}.`);
  }
  return resolved;
};

export const normalizeOptions = (
  limits: RunLimits = {},
): NormalizedRunOptions => ({
  maxBridgeRequests: positiveInteger(
    limits.maxBridgeRequests,
    DEFAULT_MAX_BRIDGE_REQUESTS,
    'limits.maxBridgeRequests',
  ),
  maxConsoleOutputBytes: positiveInteger(
    limits.maxConsoleOutputBytes,
    DEFAULT_MAX_CONSOLE_OUTPUT_BYTES,
    'limits.maxConsoleOutputBytes',
  ),
  maxContinuationBytes: positiveInteger(
    limits.maxContinuationBytes,
    DEFAULT_MAX_CONTINUATION_BYTES,
    'limits.maxContinuationBytes',
  ),
  maxHostFunctionInputBytes: positiveInteger(
    limits.maxHostFunctionArgumentsBytes,
    DEFAULT_MAX_HOST_FUNCTION_ARGUMENTS_BYTES,
    'limits.maxHostFunctionArgumentsBytes',
  ),
  maxHostFunctionOutputBytes: positiveInteger(
    limits.maxHostFunctionOutputBytes,
    DEFAULT_MAX_HOST_FUNCTION_OUTPUT_BYTES,
    'limits.maxHostFunctionOutputBytes',
  ),
  maxInFlightBridgeRequests: positiveInteger(
    limits.maxInFlightBridgeRequests,
    DEFAULT_MAX_IN_FLIGHT_BRIDGE_REQUESTS,
    'limits.maxInFlightBridgeRequests',
  ),
  maxResultBytes: positiveInteger(
    limits.maxResultBytes,
    DEFAULT_MAX_RESULT_BYTES,
    'limits.maxResultBytes',
  ),
  maxSourceBytes: positiveInteger(
    limits.maxSourceBytes,
    DEFAULT_MAX_SOURCE_BYTES,
    'limits.maxSourceBytes',
  ),
  maxStackSizeBytes: positiveInteger(
    limits.maxStackSizeBytes,
    DEFAULT_STACK_LIMIT_BYTES,
    'limits.maxStackSizeBytes',
  ),
  memoryLimitBytes: positiveInteger(
    limits.memoryLimitBytes,
    DEFAULT_MEMORY_LIMIT_BYTES,
    'limits.memoryLimitBytes',
  ),
  timeoutMs: positiveInteger(
    limits.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    'limits.timeoutMs',
  ),
});
