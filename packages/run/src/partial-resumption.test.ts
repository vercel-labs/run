import { describe, expect, it, vi } from 'vitest';
import { getHostFunctionContext, run } from './index.js';
import type { RunInterruptedResult, RunResult } from './index.js';

const requireInterrupted = (
  result: RunResult<unknown, string>,
): RunInterruptedResult<string> => {
  expect(result.status).toBe('interrupted');
  if (result.status !== 'interrupted') {
    throw new Error('Expected an interruption.');
  }
  return result;
};

describe.each([0, 1])(
  'partial resumption with call %i resolved first',
  selected => {
    it.each([
      {
        kind: 'Promise.all',
        source: `return await Promise.all([tools.pause('first'), tools.pause('second')]);`,
      },
      {
        kind: 'dependent effects',
        source: `return await Promise.all(['first', 'second'].map(async name => {
        const value = await tools.pause(name);
        return await tools.effect(value);
      }));`,
      },
      {
        kind: 'race with drain',
        source: `const calls = [tools.pause('first'), tools.pause('second')];
        const winner = await Promise.race(calls);
        await tools.effect(winner);
        return { winner, all: await Promise.all(calls) };`,
      },
      {
        kind: 'new interruptions',
        source: `return await Promise.all(['first', 'second'].map(async name => {
        const value = await tools.pause(name);
        await tools.effect(value);
        return await tools.pause(name + '-next');
      }));`,
      },
    ])(
      'preserves pending calls and replay for $kind',
      async ({ kind, source }) => {
        const resumed = vi.fn();
        const effect = vi.fn((value: unknown) => value);
        const pause = vi.fn((name: string) => {
          const context = getHostFunctionContext();
          if (context.resume === undefined) {
            return context.interrupt({ name });
          }
          resumed(name);
          return context.resume.resolution;
        });
        const input = { hostFunctions: { tools: { effect, pause } }, source };
        const initial = requireInterrupted(await run(input));
        expect(initial.interruptions).toHaveLength(2);
        const chosen = initial.interruptions[selected];
        const unresolved = initial.interruptions[1 - selected];
        if (chosen === undefined || unresolved === undefined) {
          throw new Error('Expected two pending calls.');
        }
        const selectedName = selected === 0 ? 'first' : 'second';
        let result: RunResult<unknown, string> = await run({
          ...input,
          continuation: initial.continuation,
          resolutions: [{ interruptionId: chosen.id, value: selectedName }],
        });
        const partial = requireInterrupted(result);
        expect(partial.interruptions).toContainEqual(unresolved);
        expect(partial.interruptions).toHaveLength(
          kind === 'new interruptions' ? 2 : 1,
        );
        expect(resumed.mock.calls).toEqual([[selectedName]]);
        expect(effect.mock.calls).toEqual(
          kind === 'Promise.all' ? [] : [[selectedName]],
        );
        expect(pause.mock.calls).toEqual([
          ['first'],
          ['second'],
          [selectedName],
          ...(kind === 'new interruptions' ? [[`${selectedName}-next`]] : []),
        ]);

        let rounds = 0;
        while (result.status === 'interrupted') {
          rounds += 1;
          expect(rounds).toBeLessThanOrEqual(3);
          const next = result.interruptions.at(-1);
          if (next === undefined) {
            throw new Error('Expected a remaining interruption.');
          }
          result = await run({
            ...input,
            continuation: result.continuation,
            resolutions: [
              { interruptionId: next.id, value: next.arguments[0] },
            ],
          });
        }

        let expected: unknown = ['first', 'second'];
        if (kind === 'race with drain') {
          expected = { all: ['first', 'second'], winner: selectedName };
        } else if (kind === 'new interruptions') {
          expected = ['first-next', 'second-next'];
        }
        expect(result).toEqual({ status: 'completed', value: expected });
        const callCount = kind === 'new interruptions' ? 4 : 2;
        expect(pause).toHaveBeenCalledTimes(callCount * 2);
        expect(resumed).toHaveBeenCalledTimes(callCount);
        let expectedEffects: string[][] = [];
        if (kind === 'race with drain') {
          expectedEffects = [[selectedName]];
        } else if (kind !== 'Promise.all') {
          expectedEffects = [
            [selectedName],
            [selected === 0 ? 'second' : 'first'],
          ];
        }
        expect(effect.mock.calls).toEqual(expectedEffects);
      },
    );
  },
);

describe('partial resumption', () => {
  it('accepts multiple resolutions while leaving another call pending', async () => {
    const pause = vi.fn(() => {
      const context = getHostFunctionContext();
      if (context.resume === undefined) {
        return context.interrupt({ kind: 'pause' });
      }
      return context.resume.resolution;
    });
    const input = {
      hostFunctions: { tools: { pause } },
      source:
        'return await Promise.all([tools.pause(), tools.pause(), tools.pause()]);',
    };
    const initial = requireInterrupted(await run(input));
    expect(initial.interruptions).toHaveLength(3);
    const [first, middle, last] = initial.interruptions;
    if (first === undefined || middle === undefined || last === undefined) {
      throw new Error('Expected three pending calls.');
    }
    const partial = requireInterrupted(
      await run({
        ...input,
        continuation: initial.continuation,
        resolutions: [
          { interruptionId: last.id, value: 3 },
          { interruptionId: first.id, value: undefined },
        ],
      }),
    );
    expect(partial.interruptions).toEqual([middle]);
    expect(pause).toHaveBeenCalledTimes(5);
    await expect(
      run({
        ...input,
        continuation: partial.continuation,
        resolutions: [{ interruptionId: middle.id, value: 2 }],
      }),
    ).resolves.toEqual({ status: 'completed', value: [undefined, 2, 3] });
    expect(pause).toHaveBeenCalledTimes(6);
  });

  it('preserves re-interruptions and replays rejected outcomes without repeating callbacks', async () => {
    const pause = vi.fn((name: string) => {
      const context = getHostFunctionContext();
      if (context.resume === undefined) {
        return context.interrupt({ name });
      }
      if (context.resume.resolution === 'again') {
        return context.interrupt({ name, round: 2 });
      }
      if (context.resume.resolution === 'reject') {
        throw new Error('Resumed failure');
      }
      return context.resume.resolution;
    });
    const input = {
      hostFunctions: { tools: { pause } },
      source: `return await Promise.allSettled([tools.pause('first'), tools.pause('second')]);`,
    };
    const initial = requireInterrupted(await run(input));
    const [first, second] = initial.interruptions;
    if (first === undefined || second === undefined) {
      throw new Error('Expected two pending calls.');
    }
    const repeated = requireInterrupted(
      await run({
        ...input,
        continuation: initial.continuation,
        resolutions: [{ interruptionId: first.id, value: 'again' }],
      }),
    );
    expect(repeated.interruptions).toEqual([
      { ...first, payload: { name: 'first', round: 2 } },
      second,
    ]);
    const rejected = requireInterrupted(
      await run({
        ...input,
        continuation: repeated.continuation,
        resolutions: [{ interruptionId: first.id, value: 'reject' }],
      }),
    );
    expect(rejected.interruptions).toEqual([second]);
    await expect(
      run({
        ...input,
        continuation: rejected.continuation,
        resolutions: [{ interruptionId: second.id, value: 'done' }],
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      value: [
        { reason: { message: 'Host function failed.' }, status: 'rejected' },
        { status: 'fulfilled', value: 'done' },
      ],
    });
    expect(pause.mock.calls).toEqual([
      ['first'],
      ['second'],
      ['first'],
      ['first'],
      ['second'],
    ]);
  });
});
