/**
 * Accumulates the time a worker spends running guest JavaScript.
 *
 * The clock runs while guest code may execute and stops while the worker
 * waits on the host. Nested calls only change the clock at the outermost
 * transition, so an excluded wait inside a measured operation pauses it and
 * a measured callback inside an excluded wait runs it.
 */
export interface GuestClock {
  elapsedMs(): number;
  measure<T>(operation: () => T): T;
  measureAsync<T>(operation: () => Promise<T>): Promise<T>;
  exclude<T>(operation: () => T): T;
  excludeAsync<T>(operation: () => Promise<T>): Promise<T>;
}

export function createGuestClock(
  now: () => number = () => performance.now(),
): GuestClock {
  let accumulatedMs = 0;
  let startedAt: number | undefined;

  const start = (): boolean => {
    if (startedAt !== undefined) {
      return false;
    }
    startedAt = now();
    return true;
  };

  const stop = (): boolean => {
    if (startedAt === undefined) {
      return false;
    }
    accumulatedMs += now() - startedAt;
    startedAt = undefined;
    return true;
  };

  return {
    elapsedMs: () =>
      accumulatedMs + (startedAt === undefined ? 0 : now() - startedAt),
    exclude: operation => {
      const stopped = stop();
      try {
        return operation();
      } finally {
        if (stopped) {
          start();
        }
      }
    },
    excludeAsync: async operation => {
      const stopped = stop();
      try {
        return await operation();
      } finally {
        if (stopped) {
          start();
        }
      }
    },
    measure: operation => {
      const started = start();
      try {
        return operation();
      } finally {
        if (started) {
          stop();
        }
      }
    },
    measureAsync: async operation => {
      const started = start();
      try {
        return await operation();
      } finally {
        if (started) {
          stop();
        }
      }
    },
  };
}

/** Inputs for {@link getExceededLimit}, with times in milliseconds. */
export interface ExceededLimitInput {
  /** Guest time accumulated by the invocation's {@link GuestClock}. */
  cpuElapsedMs: number;
  cpuTimeoutMs: number;
  /** Wall-clock deadline on the same clock as `now`. */
  deadline: number;
  now: number;
}

/**
 * Returns the limit an interrupt check should report, or `undefined` when
 * neither is exceeded.
 *
 * Both limits can be crossed between two checks, for example when a host wait
 * ends after the wall deadline and the guest then exhausts its CPU budget.
 * Guest time only advances while the guest runs, so the CPU limit was crossed
 * about `cpuElapsedMs - cpuTimeoutMs` before `now`. The earlier crossing wins.
 */
export function getExceededLimit({
  cpuElapsedMs,
  cpuTimeoutMs,
  deadline,
  now,
}: ExceededLimitInput): 'cpu' | 'wall' | undefined {
  const cpuOverrunMs = cpuElapsedMs - cpuTimeoutMs;
  const wallExceeded = now > deadline;
  if (cpuOverrunMs <= 0) {
    return wallExceeded ? 'wall' : undefined;
  }
  return wallExceeded && now - cpuOverrunMs >= deadline ? 'wall' : 'cpu';
}
