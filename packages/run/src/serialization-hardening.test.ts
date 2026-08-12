import { describe, expect, it, vi } from 'vitest';
import {
  RunHostFunctionError,
  createRunner,
  getHostFunctionContext,
  run,
} from './index.js';
import type { HostFunctionContext, RunContinuationState } from './index.js';
import { invokeHostFunction } from './host-function-invocation.js';
import { serializeError } from './errors.js';
import { serializeRunValue } from './utils/serde.js';

function hostFunctionContext(): HostFunctionContext {
  return {
    abortSignal: new AbortController().signal,
    hostFunctionName: 'tools.echo',
    interrupt: () => {
      throw new Error('not used');
    },
    invocationId: 'invocation-1',
    logicalRunId: 'logical-run-1',
    requestId: 'request-1',
    requestIndex: 1,
  };
}

function state(): RunContinuationState {
  return {
    determinism: {
      dateNowMs: 1_700_000_000_000,
      randomSeed: '01'.repeat(16),
    },
    ledger: [
      {
        bindingName: 'tools.pause',
        inputJson: '[[]]',
        interruptionId: 'interrupt-1',
        payloadJson: '[{"kind":1},"pause"]',
        status: 'interrupted',
      },
    ],
    logicalRunId: '03'.repeat(16),
    runtime: 'run-replay-v2',
    scopeHash: '02'.repeat(32),
    serde: 'run-js-v1',
    source: 'return await tools.pause();',
    version: 2,
  };
}

class NonSerializableValue {
  readonly value = true;
}

const NON_SERIALIZABLE_OUTPUTS: [string, () => unknown][] = [
  ['function output', (): unknown => () => {}],
  ['symbol output', (): unknown => Symbol('value')],
  ['class instance output', (): unknown => new NonSerializableValue()],
];

describe('serialization boundaries', () => {
  it.each(['ascii', 'é', '🧪', '\uD800'])(
    'measures host function arguments as UTF-8 bytes: %s',
    async text => {
      const inputJson = serializeRunValue([text]);
      const exactBytes = Buffer.byteLength(inputJson);
      const hostFunction = vi.fn((input: unknown) => input);

      await expect(
        invokeHostFunction({
          hostFunctionManifest: new Map([['tools', new Set(['echo'])]]),
          hostFunctionName: 'tools.echo',
          hostFunctions: { tools: { echo: hostFunction } },
          context: hostFunctionContext(),
          inputJson,
          maxHostFunctionInputBytes: exactBytes,
          maxHostFunctionOutputBytes: 1024,
        }),
      ).resolves.toMatchObject({ status: 'fulfilled' });

      await expect(
        invokeHostFunction({
          hostFunctionManifest: new Map([['tools', new Set(['echo'])]]),
          hostFunctionName: 'tools.echo',
          hostFunctions: { tools: { echo: hostFunction } },
          context: hostFunctionContext(),
          inputJson,
          maxHostFunctionInputBytes: exactBytes - 1,
          maxHostFunctionOutputBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(RunHostFunctionError);
    },
  );

  it.each(['ascii', 'é', '🧪'])(
    'enforces exact result byte boundaries: %s',
    async text => {
      const encodedBytes = Buffer.byteLength(serializeRunValue(text));
      await expect(
        run({
          limits: { maxResultBytes: encodedBytes },
          source: `return ${JSON.stringify(text)};`,
        }),
      ).resolves.toEqual({ status: 'completed', value: text });
      await expect(
        run({
          limits: { maxResultBytes: encodedBytes - 1 },
          source: `return ${JSON.stringify(text)};`,
        }),
      ).rejects.toMatchObject({ code: 'RUN_SERIALIZATION_ERROR' });
    },
  );

  it('preserves prototype-sensitive keys without polluting prototypes', async () => {
    const observe = vi.fn((input: Record<string, unknown>) => ({
      hasOwnProto: Object.hasOwn(input, '__proto__'),
      input,
      polluted: ({} as { polluted?: unknown }).polluted,
    }));
    const result = await run({
      hostFunctions: { tools: { observe } },
      source: `
        return await tools.observe(
          JSON.parse('{"__proto__":{"polluted":true},"constructor":"value","prototype":"value"}')
        );
      `,
    });
    expect(result).toMatchObject({
      status: 'completed',
      value: {
        hasOwnProto: true,
        input: {
          __proto__: { polluted: true },
          constructor: 'value',
          prototype: 'value',
        },
      },
    });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('preserves edge values across host function and result boundaries', async () => {
    const result = await run({
      hostFunctions: { tools: { values: input => input } },
      source: `
        return await tools.values({
          array: [undefined, NaN, Infinity, -Infinity],
          object: { omitted: undefined, nan: NaN, infinity: Infinity }
        });
      `,
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      return;
    }
    const value = result.value as {
      array: unknown[];
      object: Record<string, unknown>;
    };
    expect(value.array[0]).toBeUndefined();
    expect(Number.isNaN(value.array[1])).toBe(true);
    expect(value.array.slice(2)).toEqual([Infinity, -Infinity]);
    expect(Object.hasOwn(value.object, 'omitted')).toBe(true);
    expect(value.object.omitted).toBeUndefined();
    expect(Number.isNaN(value.object.nan)).toBe(true);
    expect(value.object.infinity).toBe(Infinity);
  });

  it.each(NON_SERIALIZABLE_OUTPUTS)(
    'rejects a non-serializable host function %s',
    async (_name, output) => {
      await expect(
        run({
          hostFunctions: { tools: { output } },
          source: 'return await tools.output();',
        }),
      ).rejects.toMatchObject({ code: 'RUN_SERIALIZATION_ERROR' });
    },
  );

  it('preserves rich values in resolutions', async () => {
    const observed: unknown[] = [];
    const source = 'return await tools.pause();';
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'pause' });
          }
          observed.push(context.resume?.resolution);
          return context.resume?.resolution;
        },
      },
    };
    const first = await run({ hostFunctions, source });
    if (first.status !== 'interrupted') {
      throw new Error('Expected interruption.');
    }
    const interruption = first.interruptions.at(0);
    if (interruption === undefined) {
      throw new Error('Expected an interruption.');
    }
    const date = new Date('2025-01-02T03:04:05.000Z');
    await expect(
      run({
        hostFunctions,
        continuation: first.continuation,
        resolutions: [{ interruptionId: interruption.id, value: date }],
        source,
      }),
    ).resolves.toEqual({ status: 'completed', value: date });
    expect(observed).toEqual([date]);
  });

  it('rejects custom codec state with accessors, cycles, or non-plain values', async () => {
    const malformedStates: unknown[] = [];
    const accessor = state();
    Object.defineProperty(accessor, 'ledger', {
      get() {
        throw new Error('accessor executed');
      },
    });
    malformedStates.push(accessor);
    const cyclic = state() as RunContinuationState & { cycle?: unknown };
    cyclic.cycle = cyclic;
    malformedStates.push(cyclic);
    malformedStates.push({ ...state(), determinism: new Date() });

    for (const malformed of malformedStates) {
      const runner = createRunner({
        continuationCodec: {
          decode: () => malformed as never,
          encode: () => 'unused',
        },
      });
      await expect(
        runner.run({ continuation: 'token', source: state().source }),
      ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    }
  });

  it('bounds and sanitizes serialized errors and hostile properties', () => {
    const error = new Error('x'.repeat(100_000));
    Object.defineProperty(error, 'details', {
      get() {
        throw new Error('details getter');
      },
    });
    error.stack = `Error: secret\n    at data:text/javascript;base64,${'a'.repeat(100_000)}`;
    const serialized = serializeError(error);
    expect(Buffer.byteLength(JSON.stringify(serialized))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(serialized.stack).not.toContain('data:text/javascript;base64');
    expect(serialized.details).toBeUndefined();
  });
});
