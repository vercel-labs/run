import { describe, expect, it, vi } from 'vitest';
import { getHostFunctionContext, run } from './index.js';

interface RichResult {
  alias: unknown;
  bigint: bigint;
  bytes: Uint8Array;
  cycle: { self: unknown };
  date: Date;
  error: TypeError & { cause?: unknown };
  map: Map<string, unknown>;
  regexp: RegExp;
  set: Set<unknown>;
  shared: unknown;
  sparse: unknown[];
  specialNumbers: number[];
  undefinedValue?: unknown;
  view: DataView;
}

interface ExchangeInput {
  error: RangeError & { cause?: unknown };
  exact: bigint;
  self: unknown;
  set: Set<unknown>;
}

interface ExchangeResult {
  identity: boolean;
  output: {
    alias: unknown;
    bytes: Uint16Array;
    cycle: { self: unknown };
    map: Map<string, unknown>;
    shared: unknown;
  };
}

interface ResolutionValue {
  approved: Set<string>;
  self: unknown;
}

describe('run-js-v1 serialization', () => {
  it('preserves rich final results and graph identity', async () => {
    const result = await run({
      source: `
        const shared = { value: 1 };
        const cycle = { label: 'cycle' };
        cycle.self = cycle;
        return {
          undefinedValue: undefined,
          specialNumbers: [NaN, Infinity, -Infinity, -0],
          bigint: 9007199254740993n,
          date: new Date(0),
          regexp: /run+/gi,
          map: new Map([['shared', shared]]),
          set: new Set([shared]),
          bytes: new Uint8Array([0, 127, 255]),
          view: new DataView(new Uint8Array([1, 2, 3]).buffer),
          sparse: [, 'value'],
          shared,
          alias: shared,
          cycle,
          error: new TypeError('invalid', { cause: shared }),
        };
      `,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      return;
    }
    const value = result.value as RichResult;
    expect(Object.hasOwn(value, 'undefinedValue')).toBe(true);
    expect(value.undefinedValue).toBeUndefined();
    expect(Number.isNaN(value.specialNumbers[0])).toBe(true);
    expect(value.specialNumbers.slice(1, 3)).toEqual([Infinity, -Infinity]);
    expect(Object.is(value.specialNumbers[3], -0)).toBe(true);
    expect(value.bigint).toBe(9_007_199_254_740_993n);
    expect(value.date).toEqual(new Date(0));
    expect(value.regexp).toEqual(/run+/gi);
    expect(value.bytes).toEqual(new Uint8Array([0, 127, 255]));
    expect(value.view).toBeInstanceOf(DataView);
    expect(value.view.getUint8(1)).toBe(2);
    expect(0 in value.sparse).toBe(false);
    expect(value.shared).toBe(value.alias);
    expect(value.map.get('shared')).toBe(value.shared);
    expect([...value.set]).toEqual([value.shared]);
    expect(value.cycle.self).toBe(value.cycle);
    expect(value.error).toBeInstanceOf(TypeError);
    expect(value.error).toMatchObject({
      message: 'invalid',
      name: 'TypeError',
    });
    expect(value.error.cause).toBe(value.shared);
    expect(value.error.stack).not.toContain('run.js');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'safely revives an Error with inherited object name %s',
    async name => {
      const result = await run({
        source: `
          const error = new Error('guest message');
          error.name = ${JSON.stringify(name)};
          return error;
        `,
      });

      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        return;
      }
      expect(result.value).toBeInstanceOf(Error);
      expect(result.value).toMatchObject({
        message: 'guest message',
        name,
      });
    },
  );

  it('passes an Error named constructor to host functions as an Error', async () => {
    const inspect = vi.fn((input: unknown) => {
      expect(input).toBeInstanceOf(Error);
      expect(input).toMatchObject({
        message: 'guest message',
        name: 'constructor',
      });
      return input instanceof Error;
    });

    const result = await run({
      hostFunctions: { tools: { inspect } },
      source: `
        const error = new Error('guest message');
        error.name = 'constructor';
        return await tools.inspect(error);
      `,
    });

    expect(inspect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'completed',
      value: true,
    });
  });

  it('uses the same rich codec in both host function directions', async () => {
    const execute = vi.fn((input: ExchangeInput) => {
      expect(input.self).toBe(input);
      expect(input.set).toBeInstanceOf(Set);
      expect(input.exact).toBe(42n);
      expect(input.error).toBeInstanceOf(RangeError);
      expect(input.error.cause).toBe(input);

      const shared = { origin: 'host' };
      const cycle: Record<string, unknown> = { shared };
      cycle.self = cycle;
      return {
        alias: shared,
        bytes: new Uint16Array([1, 65_535]),
        cycle,
        map: new Map([['shared', shared]]),
        shared,
      };
    });

    const result = await run({
      hostFunctions: { tools: { exchange: execute } },
      source: `
        const input = { set: new Set([1, 2]), exact: 42n };
        input.self = input;
        input.error = new RangeError('range', { cause: input });
        const output = await tools.exchange(input);
        return {
          identity: output.shared === output.alias &&
            output.map.get('shared') === output.shared &&
            output.cycle.self === output.cycle,
          output,
        };
      `,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      return;
    }
    const value = result.value as ExchangeResult;
    expect(value.identity).toBe(true);
    expect(value.output.shared).toBe(value.output.alias);
    expect(value.output.cycle.self).toBe(value.output.cycle);
    expect(value.output.map.get('shared')).toBe(value.output.shared);
    expect(value.output.bytes).toEqual(new Uint16Array([1, 65_535]));
  });

  it('preserves rich interruption payloads and resolutions through replay', async () => {
    const source = 'return await tools.pause();';
    const observed: unknown[] = [];
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          const { resume } = context;
          if (resume === undefined) {
            const shared = { kind: 'approval' };
            const payload: Record<string, unknown> = {
              alias: shared,
              exact: 7n,
              shared,
            };
            payload.self = payload;
            return context.interrupt(payload);
          }
          observed.push(resume.resolution);
          return resume.resolution;
        },
      },
    };

    const interrupted = await run({ hostFunctions, source });
    expect(interrupted.status).toBe('interrupted');
    if (interrupted.status !== 'interrupted') {
      return;
    }
    const interruption = interrupted.interruptions.at(0);
    if (interruption === undefined) {
      throw new Error('Expected an interruption.');
    }
    const payload = interruption.payload as Record<string, unknown>;
    expect(payload.shared).toBe(payload.alias);
    expect(payload.self).toBe(payload);
    expect(payload.exact).toBe(7n);

    const resolution: Record<string, unknown> = {
      approved: new Set(['one', 'two']),
    };
    resolution.self = resolution;
    const completed = await run({
      continuation: interrupted.continuation,
      hostFunctions,
      resolutions: [
        {
          interruptionId: interruption.id,
          value: resolution,
        },
      ],
      source,
    });
    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') {
      return;
    }
    const value = completed.value as ResolutionValue;
    expect(value.self).toBe(value);
    expect(value.approved).toEqual(new Set(['one', 'two']));
    const observedResolution = observed.at(0) as ResolutionValue;
    expect(observedResolution.self).toBe(observedResolution);
    expect(observedResolution.approved).toEqual(new Set(['one', 'two']));
  });

  it('reports the path of unsupported values', async () => {
    await expect(
      run({ source: 'return { nested: { callback() {} } };' }),
    ).rejects.toMatchObject({
      code: 'RUN_SERIALIZATION_ERROR',
      message: expect.stringMatching(/nested\.callback|function/u),
    });
  });
});
