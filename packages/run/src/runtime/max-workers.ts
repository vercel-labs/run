import os from 'node:os';

const DEFAULT_MAX_WORKERS_CAP = 32;
const DEFAULT_WORKER_OVERHEAD_BYTES = 48 * 1024 * 1024;

let configuredMaxWorkers: number | undefined;
let memoryBudgetBytes: number | undefined;
let reservedMemoryBytes = 0;

/** @internal */
export interface WorkerMemoryReservation {
  readonly admittedUnderHold: boolean;
  readonly bytes: number;
  readonly reserveWorkers: number;
}

const UNMETERED_RESERVATION: WorkerMemoryReservation = Object.freeze({
  admittedUnderHold: false,
  bytes: 0,
  reserveWorkers: 0,
});
const activeReservations = new Set<WorkerMemoryReservation>();

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

interface ReserveHold {
  freeBytes: number;
  reserveBytes: number;
  reserveWorkers: number;
}

// Assumes live availability has dropped since the snapshot only through what
// reserved workers allocated. Workers admitted while a reserve is held may not
// have allocated yet, so their estimates are taken off it.
const getReserveHold = (): ReserveHold | undefined => {
  let reserveBytes = 0;
  let reserveWorkers = 0;
  let unsettledBytes = 0;
  for (const reservation of activeReservations) {
    reserveBytes = Math.max(
      reserveBytes,
      reservation.bytes * reservation.reserveWorkers,
    );
    reserveWorkers = Math.max(reserveWorkers, reservation.reserveWorkers);
    if (reservation.admittedUnderHold) {
      unsettledBytes += reservation.bytes;
    }
  }
  if (reserveWorkers === 0 || memoryBudgetBytes === undefined) {
    return undefined;
  }
  return {
    freeBytes: Math.min(
      availableMemory() - unsettledBytes,
      memoryBudgetBytes - reservedMemoryBytes,
    ),
    reserveBytes,
    reserveWorkers,
  };
};

/**
 * Returns the admission limits while a reserving invocation runs: the worker
 * cap, as the active invocations plus the workers the remaining memory fits,
 * and the largest held reserve. Returns `undefined` when no reserve is held or
 * an explicit cap is configured.
 *
 * @internal
 */
export const getReserveHoldAdmission = ({
  activeInvocations,
  additionalMemoryBytes = 0,
  memoryLimitBytes,
}: {
  activeInvocations: number;
  additionalMemoryBytes?: number;
  memoryLimitBytes: number;
}): { maxWorkers: number; reserveWorkers: number } | undefined => {
  const hold =
    configuredMaxWorkers === undefined ? getReserveHold() : undefined;
  if (hold === undefined) {
    return undefined;
  }
  return {
    maxWorkers: Math.min(
      DEFAULT_MAX_WORKERS_CAP,
      activeInvocations +
        Math.max(
          0,
          Math.floor(
            hold.freeBytes /
              estimatedWorkerBytes(memoryLimitBytes, additionalMemoryBytes),
          ),
        ),
    ),
    reserveWorkers: hold.reserveWorkers,
  };
};

/**
 * Reserves the estimated memory for an invocation before it can allocate.
 *
 * Returns the reservation, of zero bytes when an explicit count cap is
 * configured, `undefined` when the dynamic memory budget cannot cover this
 * worker, or `'reserve'` when it cannot also keep `reserveWorkers` more of the
 * same size free. While reserving invocations run, a reserving admission must
 * also keep the largest of their reserves free, in bytes and in workers under
 * the cap.
 *
 * @internal
 */
export const reserveWorkerMemory = (
  memoryLimitBytes: number,
  additionalMemoryBytes = 0,
  reserveWorkers = 0,
  activeInvocations = 0,
): WorkerMemoryReservation | 'reserve' | undefined => {
  if (configuredMaxWorkers !== undefined) {
    return UNMETERED_RESERVATION;
  }

  const reservationBytes = estimatedWorkerBytes(
    memoryLimitBytes,
    additionalMemoryBytes,
  );
  const hold = getReserveHold();
  if (hold === undefined) {
    const budgetBytes =
      memoryBudgetBytes ?? Math.max(reservationBytes, availableMemory());
    if (reservedMemoryBytes + reservationBytes > budgetBytes) {
      return undefined;
    }
    if (
      reservedMemoryBytes + reservationBytes * (1 + reserveWorkers) >
      budgetBytes
    ) {
      return 'reserve';
    }
    memoryBudgetBytes = budgetBytes;
  } else {
    if (
      reservationBytes > hold.freeBytes ||
      activeInvocations >= DEFAULT_MAX_WORKERS_CAP
    ) {
      return undefined;
    }
    if (
      reserveWorkers > 0 &&
      (reservationBytes +
        Math.max(hold.reserveBytes, reservationBytes * reserveWorkers) >
        hold.freeBytes ||
        activeInvocations + 1 + Math.max(hold.reserveWorkers, reserveWorkers) >
          DEFAULT_MAX_WORKERS_CAP)
    ) {
      return 'reserve';
    }
  }
  const reservation: WorkerMemoryReservation = {
    admittedUnderHold: hold !== undefined,
    bytes: reservationBytes,
    reserveWorkers,
  };
  activeReservations.add(reservation);
  reservedMemoryBytes += reservationBytes;
  return reservation;
};

/**
 * Releases a reservation returned by `reserveWorkerMemory`.
 *
 * @internal
 */
export const releaseWorkerMemory = (
  reservation: WorkerMemoryReservation,
): void => {
  if (!activeReservations.delete(reservation)) {
    return;
  }
  reservedMemoryBytes = Math.max(0, reservedMemoryBytes - reservation.bytes);
  if (activeReservations.size === 0) {
    memoryBudgetBytes = undefined;
    reservedMemoryBytes = 0;
  }
};
