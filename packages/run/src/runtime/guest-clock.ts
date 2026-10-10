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
