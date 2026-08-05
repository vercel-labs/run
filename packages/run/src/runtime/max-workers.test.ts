import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMaxWorkers, setMaxWorkers } from './max-workers.js';

describe('max workers', () => {
  afterEach(() => {
    setMaxWorkers(undefined);
    vi.restoreAllMocks();
  });

  it('honors an explicit process-wide cap', () => {
    setMaxWorkers(7);
    expect(getMaxWorkers({ activeWorkers: 0, memoryLimitBytes: 1 })).toBe(7);
  });

  it('admits at least one worker and caps the memory heuristic at 32', () => {
    const workerBytes = 64 * 1024 * 1024;
    vi.spyOn(process, 'availableMemory').mockReturnValue(workerBytes - 1);
    expect(
      getMaxWorkers({
        activeWorkers: 0,
        memoryLimitBytes: 16 * 1024 * 1024,
      }),
    ).toBe(1);

    vi.mocked(process.availableMemory).mockReturnValue(workerBytes * 100);
    expect(
      getMaxWorkers({
        activeWorkers: 0,
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
          activeWorkers: 0,
          memoryLimitBytes: 16 * 1024 * 1024,
        }),
      ).toBe(2);
    } finally {
      Object.defineProperty(process, 'availableMemory', descriptor);
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
