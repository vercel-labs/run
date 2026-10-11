import { describe, expect, it } from 'vitest';
import { createGuestClock, getExceededLimit } from './guest-clock.js';

const createManualClock = () => {
  let now = 0;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    clock: createGuestClock(() => now),
  };
};

describe('guest clock', () => {
  it('counts only measured time', () => {
    const { advance, clock } = createManualClock();
    advance(100);
    clock.measure(() => advance(10));
    advance(100);
    clock.measure(() => {
      advance(5);
      expect(clock.elapsedMs()).toBe(15);
    });
    expect(clock.elapsedMs()).toBe(15);
  });

  it('pauses for excluded waits and resumes for nested guest work', () => {
    const { advance, clock } = createManualClock();
    clock.measure(() => {
      advance(10);
      clock.exclude(() => {
        advance(1000);
        clock.measure(() => advance(3));
        advance(1000);
      });
      clock.measure(() => advance(2));
      advance(5);
    });
    expect(clock.elapsedMs()).toBe(20);
  });

  it('pauses across asynchronous waits', async () => {
    const { advance, clock } = createManualClock();
    await clock.measureAsync(async () => {
      advance(10);
      await clock.excludeAsync(async () => {
        await Promise.resolve();
        advance(1000);
      });
      advance(5);
    });
    expect(clock.elapsedMs()).toBe(15);
  });

  it('restores its state when an operation throws', () => {
    const { advance, clock } = createManualClock();
    expect(() =>
      clock.measure(() => {
        advance(10);
        clock.exclude(() => {
          advance(1000);
          throw new Error('host failure');
        });
      }),
    ).toThrow('host failure');
    advance(1000);
    expect(clock.elapsedMs()).toBe(10);
  });
});

describe('getExceededLimit', () => {
  const limits = { cpuTimeoutMs: 100, deadline: 1000 };

  it.each([
    ['neither limit is exceeded', 100, 1000, undefined],
    ['only the CPU limit is exceeded', 101, 500, 'cpu'],
    ['only the wall deadline is exceeded', 50, 1001, 'wall'],
    // The guest resumed after a host wait that ended past the deadline, then
    // ran 30ms. Its CPU limit was crossed at 1020, after the deadline.
    ['the CPU limit was crossed after the deadline', 110, 1030, 'wall'],
    // The guest crossed its CPU limit at 990 and the next check ran at 1010.
    ['the CPU limit was crossed before the deadline', 120, 1010, 'cpu'],
  ] as const)('reports %s', (_name, cpuElapsedMs, now, expected) => {
    expect(getExceededLimit({ ...limits, cpuElapsedMs, now })).toBe(expected);
  });
});
