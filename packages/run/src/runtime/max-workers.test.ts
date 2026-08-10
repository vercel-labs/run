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
    if (largeReservation === undefined) {
      throw new Error('Expected the first worker reservation to succeed.');
    }

    try {
      expect(largeReservation).toBe(176 * mib);
      expect(reserveWorkerMemory(16 * mib)).toBeUndefined();
    } finally {
      releaseWorkerMemory(largeReservation);
    }

    const smallReservation = reserveWorkerMemory(16 * mib);
    if (smallReservation === undefined) {
      throw new Error('Expected released capacity to be reusable.');
    }
    try {
      expect(smallReservation).toBe(64 * mib);
    } finally {
      releaseWorkerMemory(smallReservation);
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
