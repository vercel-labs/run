import os from 'node:os';

const DEFAULT_MAX_WORKERS_CAP = 32;
const DEFAULT_WORKER_OVERHEAD_BYTES = 48 * 1024 * 1024;

let configuredMaxWorkers: number | undefined;
let memoryBudgetBytes: number | undefined;
let reservedMemoryBytes = 0;

const availableMemory = (): number => {
  const processWithAvailableMemory = process as typeof process & {
    availableMemory?: () => number;
  };
  const bytes =
    typeof processWithAvailableMemory.availableMemory === 'function'
      ? processWithAvailableMemory.availableMemory()
      : os.freemem();
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
};

const estimatedWorkerBytes = (
  memoryLimitBytes: number,
  additionalMemoryBytes = 0,
): number =>
  memoryLimitBytes + DEFAULT_WORKER_OVERHEAD_BYTES + additionalMemoryBytes;

/**
 * Sets the process-global maximum number of active run workers.
 *
 * Pass `undefined` or call without an argument to restore the dynamic
 * memory-based default. The default admits at least one invocation and admits
 * additional workers only when available memory can cover another worker.
 *
 * @param maxWorkers - Positive integer worker cap, or `undefined` to reset.
 */
export const setMaxWorkers = (maxWorkers?: number): void => {
  if (maxWorkers === undefined) {
    configuredMaxWorkers = undefined;
    return;
  }
  if (!Number.isInteger(maxWorkers) || maxWorkers <= 0) {
    throw new TypeError('maxWorkers must be a positive integer.');
  }
  configuredMaxWorkers = maxWorkers;
};

/**
 * Returns the currently effective worker cap.
 *
 * @internal
 */
export const getMaxWorkers = ({
  additionalMemoryBytes = 0,
  memoryLimitBytes,
}: {
  additionalMemoryBytes?: number;
  memoryLimitBytes: number;
}): number => {
  if (configuredMaxWorkers !== undefined) {
    return configuredMaxWorkers;
  }

  const memoryBasedMaxWorkers = Math.floor(
    availableMemory() /
      estimatedWorkerBytes(memoryLimitBytes, additionalMemoryBytes),
  );
  return Math.max(1, Math.min(DEFAULT_MAX_WORKERS_CAP, memoryBasedMaxWorkers));
};

/**
 * Reserves the estimated memory for an invocation before it can allocate.
 *
 * Returns the reservation size, zero when an explicit count cap is configured,
 * or `undefined` when the dynamic memory budget is exhausted.
 *
 * @internal
 */
export const reserveWorkerMemory = (
  memoryLimitBytes: number,
  additionalMemoryBytes = 0,
): number | undefined => {
  if (configuredMaxWorkers !== undefined) {
    return 0;
  }

  const reservationBytes = estimatedWorkerBytes(
    memoryLimitBytes,
    additionalMemoryBytes,
  );
  memoryBudgetBytes ??= Math.max(reservationBytes, availableMemory());
  if (reservedMemoryBytes + reservationBytes > memoryBudgetBytes) {
    return undefined;
  }
  reservedMemoryBytes += reservationBytes;
  return reservationBytes;
};

/**
 * Releases a reservation returned by `reserveWorkerMemory`.
 *
 * @internal
 */
export const releaseWorkerMemory = (reservationBytes: number): void => {
  if (reservationBytes === 0) {
    return;
  }
  reservedMemoryBytes = Math.max(0, reservedMemoryBytes - reservationBytes);
  if (reservedMemoryBytes === 0) {
    memoryBudgetBytes = undefined;
  }
};
