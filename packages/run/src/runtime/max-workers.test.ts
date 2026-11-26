import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMaxWorkers,
  releaseWorkerMemory,
  reserveWorkerMemory,
  setMaxWorkers,
} from './max-workers.js';

describe('max workers', () => {
  afterEach(() => {
    setMaxWorkers(undefined);
    vi.restoreAllMocks();
  });

  it('honors an explicit process-wide cap', () => {
    setMaxWorkers(7);
    expect(getMaxWorkers({ memoryLimitBytes: 1 })).toBe(7);
  });

  it('admits at least one worker and caps the memory heuristic at 32', () => {
    const workerBytes = 64 * 1024 * 1024;
    vi.spyOn(process, 'availableMemory').mockReturnValue(workerBytes - 1);
    expect(
      getMaxWorkers({
        memoryLimitBytes: 16 * 1024 * 1024,
      }),
    ).toBe(1);

    vi.mocked(process.availableMemory).mockReturnValue(workerBytes * 100);
    expect(
      getMaxWorkers({
        memoryLimitBytes: 16 * 1024 * 1024,
      }),
    ).toBe(32);
  });

  it('falls back to os.freemem when process.availableMemory is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process,
      'availableMemory',
    );
    if (descriptor === undefined) {
      throw new Error('Expected process.availableMemory to be defined.');
    }
    const workerBytes = 64 * 1024 * 1024;
    vi.spyOn(os, 'freemem').mockReturnValue(workerBytes * 2);
    try {
      Object.defineProperty(process, 'availableMemory', {
        configurable: true,
        value: undefined,
      });
      expect(
        getMaxWorkers({
          memoryLimitBytes: 16 * 1024 * 1024,
        }),
      ).toBe(2);
    } finally {
      Object.defineProperty(process, 'availableMemory', descriptor);
    }
  });

  it('reserves mixed worker sizes against one memory snapshot', () => {
    const mib = 1024 * 1024;
    vi.spyOn(process, 'availableMemory').mockReturnValue(200 * mib);
    const largeReservation = reserveWorkerMemory(128 * mib);
    if (typeof largeReservation !== 'object') {
      throw new TypeError('Expected the first worker reservation to succeed.');
    }

    try {
      expect(largeReservation.bytes).toBe(176 * mib);
      expect(reserveWorkerMemory(16 * mib)).toBeUndefined();
    } finally {
      releaseWorkerMemory(largeReservation);
    }

    const smallReservation = reserveWorkerMemory(16 * mib);
    if (typeof smallReservation !== 'object') {
      throw new TypeError('Expected released capacity to be reusable.');
    }
    try {
      expect(smallReservation.bytes).toBe(64 * mib);
    } finally {
      releaseWorkerMemory(smallReservation);
    }
  });

  it('includes additional invocation memory in worker admission', () => {
    const mib = 1024 * 1024;
    vi.spyOn(process, 'availableMemory').mockReturnValue(160 * mib);

    expect(
      getMaxWorkers({
        additionalMemoryBytes: 16 * mib,
        memoryLimitBytes: 16 * mib,
      }),
    ).toBe(2);
    const reservation = reserveWorkerMemory(16 * mib, 16 * mib);
    expect(reservation).toMatchObject({ bytes: 80 * mib });
    if (typeof reservation === 'object') {
      releaseWorkerMemory(reservation);
    }
  });

  const admit = (
    memoryLimitBytes: number,
    reserveWorkers: number,
    activeInvocations: number,
  ): (() => void) => {
    const reservation = reserveWorkerMemory(
      memoryLimitBytes,
      0,
      reserveWorkers,
      activeInvocations,
    );
    if (typeof reservation !== 'object') {
      throw new TypeError(`Expected admission, got ${String(reservation)}.`);
    }
    return () => releaseWorkerMemory(reservation);
  };

  it.each([
    ['reserving', [0, 1, 2]],
    ['plain', [2, 0, 1]],
  ])(
    'shares one reserve between equal reservers, releasing a %s invocation first',
    (_, releaseOrder) => {
      const mib = 1024 * 1024;
      // Three 64 MiB workers.
      const availableMemory = vi
        .spyOn(process, 'availableMemory')
        .mockReturnValue(192 * mib);
      const releases = [admit(16 * mib, 1, 0), admit(16 * mib, 1, 1)];

      try {
        expect(reserveWorkerMemory(16 * mib, 0, 1, 2)).toBe('reserve');
        releases.push(admit(16 * mib, 0, 2));
        expect(reserveWorkerMemory(16 * mib, 0, 0, 3)).toBeUndefined();
        expect(reserveWorkerMemory(16 * mib, 0, 1, 3)).toBeUndefined();

        availableMemory.mockReturnValue(1000 * mib);
        for (const index of releaseOrder.slice(0, 2)) {
          releases[index]?.();
        }
        expect(reserveWorkerMemory(16 * mib, 0, 2, 1)).toBe('reserve');
        releases[releaseOrder[2] ?? 0]?.();
        releases.length = 0;
        releases.push(admit(16 * mib, 9, 0));
      } finally {
        for (const release of releases) {
          release();
        }
      }
    },
  );

  it.each([
    ['larger', [1], 'admitted'],
    ['smaller', [2, 0], 'reserve'],
  ])(
    'holds the largest active reserve across worker sizes, releasing the %s reserver first',
    (_, releasedIndexes, afterRelease) => {
      const mib = 1024 * 1024;
      // Worker estimates: 64 MiB for 16 MiB, 112 MiB for 64 MiB.
      vi.spyOn(process, 'availableMemory').mockReturnValue(320 * mib);
      const releases = [admit(16 * mib, 1, 0), admit(64 * mib, 1, 1)];

      try {
        // 144 MiB remain: two small workers, but not one beside the 112 MiB
        // the larger reserver keeps free.
        expect(reserveWorkerMemory(16 * mib, 0, 1, 2)).toBe('reserve');
        releases.push(admit(16 * mib, 0, 2), admit(16 * mib, 0, 3));
        expect(reserveWorkerMemory(16 * mib, 0, 0, 4)).toBeUndefined();

        // 128 or 144 MiB now remain: room for a small reserver keeping a small
        // worker free (128 MiB), not for one keeping the larger one's (176).
        for (const index of releasedIndexes) {
          releases[index]?.();
          releases.splice(index, 1);
        }
        if (afterRelease === 'admitted') {
          releases.push(admit(16 * mib, 1, releases.length));
        } else {
          expect(reserveWorkerMemory(16 * mib, 0, 1, releases.length)).toBe(
            'reserve',
          );
        }
      } finally {
        for (const release of releases) {
          release();
        }
      }
    },
  );

  it('keeps reserving within the worker ceiling', () => {
    const mib = 1024 * 1024;
    vi.spyOn(process, 'availableMemory').mockReturnValue(100_000 * mib);
    const release = admit(16 * mib, 2, 0);

    try {
      expect(reserveWorkerMemory(16 * mib, 0, 1, 30)).toBe('reserve');
      admit(16 * mib, 1, 29)();
      expect(reserveWorkerMemory(16 * mib, 0, 0, 32)).toBeUndefined();
      admit(16 * mib, 0, 31)();
    } finally {
      release();
    }
  });

  it('does not keep the memory snapshot of a refused idle reservation', () => {
    const mib = 1024 * 1024;
    const availableMemory = vi
      .spyOn(process, 'availableMemory')
      .mockReturnValue(100 * mib);

    expect(reserveWorkerMemory(16 * mib, 0, 1)).toBe('reserve');
    availableMemory.mockReturnValue(1000 * mib);
    const reservation = reserveWorkerMemory(16 * mib, 0, 9);
    try {
      expect(reservation).toMatchObject({ bytes: 64 * mib });
    } finally {
      if (typeof reservation === 'object') {
        releaseWorkerMemory(reservation);
      }
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid configured cap %s',
    value => {
      expect(() => setMaxWorkers(value)).toThrow(
        'maxWorkers must be a positive integer',
      );
    },
  );
});
