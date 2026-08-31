import { describe, expect, it } from 'vitest';
import { assertContinuationState } from './continuation-validation.js';
import type { RunContinuationState } from './types.js';
import { normalizeOptions } from './utils/options.js';

const source = `
  await tools.first({ value: 1 });
  try { await tools.second({ value: 2 }); } catch {}
  return await tools.pause({ value: 3 });
`;
const scopeHash = '02'.repeat(32);

const requireEntry = <T>(values: T[], index: number): T => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing test ledger entry at index ${index}.`);
  }
  return value;
};

const validState = (): RunContinuationState => ({
  determinism: {
    dateNowMs: 1_700_000_000_000,
    randomSeed: '01'.repeat(16),
  },
  ledger: [
    {
      bindingName: 'tools.first',
      dateNowMs: 1_700_000_000_001,
      inputJson: '[[1],{"value":2},1]',
      settledOrder: 1,
      status: 'fulfilled',
      valueJson: '[true]',
    },
    {
      bindingName: 'tools.second',
      dateNowMs: 1_700_000_000_002,
      error: { message: 'expected', name: 'Error' },
      inputJson: '[[1],{"value":2},2]',
      settledOrder: 2,
      status: 'rejected',
    },
    {
      bindingName: 'tools.pause',
      inputJson: '[[1],{"value":2},3]',
      interruptionId: 'interrupt-3',
      payloadJson: '[{"kind":1},"pause"]',
      status: 'interrupted',
    },
  ],
  logicalRunId: '03'.repeat(16),
  runtime: 'run-replay-v2',
  scopeHash,
  serde: 'run-js-v1',
  source,
  version: 2,
});

const expectInvalid = (value: unknown): void => {
  expect(() =>
    assertContinuationState(value, source, scopeHash, normalizeOptions()),
  ).toThrowError(expect.objectContaining({ code: 'RUN_PROTOCOL_ERROR' }));
};

describe('continuation state validation hardening', () => {
  it('validates mixed synchronous, module, and asynchronous ledger entries', () => {
    const state = validState();
    state.ledger = [
      {
        bindingName: 'effects.write',
        bridgeKind: 'sync-host',
        inputJson: '[[1],"value"]',
        status: 'fulfilled',
        valueJson: '[1]',
      },
      {
        bindingName: 'moduleLoader.normalize',
        bridgeKind: 'module-normalize',
        inputJson: '["./value.js","<entry>"]',
        status: 'fulfilled',
        valueJson: '"/value.js"',
      },
      {
        bindingName: 'moduleLoader.load',
        bridgeKind: 'module-load',
        inputJson: '["/value.js"]',
        status: 'fulfilled',
        valueJson: '"export const value = 1;"',
      },
      {
        bindingName: 'tools.pause',
        inputJson: '[[]]',
        interruptionId: 'interrupt-4',
        payloadJson: '["pause"]',
        status: 'interrupted',
      },
    ];
    expect(() =>
      assertContinuationState(state, source, scopeHash, normalizeOptions()),
    ).not.toThrow();

    const malformed = structuredClone(state) as unknown as {
      ledger: Record<string, unknown>[];
    };
    requireEntry(malformed.ledger, 1).inputJson = '["missing-importer"]';
    expectInvalid(malformed);

    const oversized = structuredClone(state) as unknown as {
      ledger: Record<string, unknown>[];
    };
    requireEntry(oversized.ledger, 2).valueJson = JSON.stringify(
      'x'.repeat(33),
    );
    expect(() =>
      assertContinuationState(oversized, source, scopeHash, {
        ...normalizeOptions(),
        maxSourceBytes: 32,
      }),
    ).toThrowError(expect.objectContaining({ code: 'RUN_PROTOCOL_ERROR' }));
  });

  it('accepts only the exact versioned state shape', () => {
    expect(() =>
      assertContinuationState(
        validState(),
        source,
        scopeHash,
        normalizeOptions(),
      ),
    ).not.toThrow();
    for (const mutation of [
      (state: Record<string, unknown>) => {
        state.extra = true;
      },
      (state: Record<string, unknown>) => {
        (state.determinism as Record<string, unknown>).extra = true;
      },
      (state: Record<string, unknown>) => {
        ((state.ledger as unknown[])[0] as Record<string, unknown>).extra =
          true;
      },
    ]) {
      const state = validState() as unknown as Record<string, unknown>;
      mutation(state);
      expectInvalid(state);
    }
  });

  it('rejects uppercase hex random seeds at the validation boundary', () => {
    const lowercaseSeed = validState();
    lowercaseSeed.determinism.randomSeed = 'ab'.repeat(16);
    expect(() =>
      assertContinuationState(
        lowercaseSeed,
        source,
        scopeHash,
        normalizeOptions(),
      ),
    ).not.toThrow();

    const uppercaseSeed = validState();
    uppercaseSeed.determinism.randomSeed = 'AB'.repeat(16);
    expect(() =>
      assertContinuationState(
        uppercaseSeed,
        source,
        scopeHash,
        normalizeOptions(),
      ),
    ).toThrowError('Continuation determinism state is invalid.');
  });

  it('rejects sparse arrays, cycles, accessors, and non-plain objects', () => {
    const sparse = validState();
    sparse.ledger = [];
    sparse.ledger.length = 3;
    sparse.ledger[0] = requireEntry(validState().ledger, 0);
    sparse.ledger[2] = requireEntry(validState().ledger, 2);
    expectInvalid(sparse);

    const cycle = validState() as RunContinuationState & { cycle?: unknown };
    cycle.cycle = cycle;
    expectInvalid(cycle);

    const accessor = validState();
    Object.defineProperty(accessor.determinism, 'randomSeed', {
      get() {
        throw new Error('accessor failure');
      },
    });
    expectInvalid(accessor);

    expectInvalid({ ...validState(), determinism: new Date() });
  });

  it('fails closed for 10,000 structure-aware state mutations', () => {
    let random = 2_738_958_700;
    const next = (): number => {
      random = (random * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return random;
    };
    const generatedJson = (depth: number): unknown => {
      if (depth > 2) {
        return next() % 2 === 0 ? next() : `v-${next()}`;
      }
      return next() % 2 === 0
        ? Array.from({ length: next() % 4 }, () => generatedJson(depth + 1))
        : { value: generatedJson(depth + 1) };
    };

    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const state = validState() as unknown as Record<string, unknown>;
      const ledger = state.ledger as Record<string, unknown>[];
      switch (next() % 12) {
        case 0: {
          state.version = next();
          break;
        }
        case 1: {
          state.runtime = `runtime-${next()}`;
          break;
        }
        case 2: {
          state.source = `${source}\n${next()}`;
          break;
        }
        case 3: {
          (state.determinism as Record<string, unknown>).randomSeed =
            `${next()}`;
          break;
        }
        case 4: {
          (state.determinism as Record<string, unknown>).dateNowMs = -1;
          break;
        }
        case 5: {
          requireEntry(ledger, next() % ledger.length).bindingName =
            'constructor';
          break;
        }
        case 6: {
          requireEntry(ledger, next() % ledger.length).inputJson = '{';
          break;
        }
        case 7: {
          requireEntry(ledger, 0).settledOrder = 2;
          break;
        }
        case 8: {
          requireEntry(ledger, 1).error = {
            extra: true,
            message: 'x',
            name: 'Error',
          };
          break;
        }
        case 9: {
          requireEntry(ledger, 2).interruptionId = `interrupt-${next()}`;
          break;
        }
        case 10: {
          requireEntry(ledger, 2).payloadJson = '{';
          break;
        }
        default: {
          requireEntry(ledger, next() % ledger.length).extra = generatedJson(0);
        }
      }
      expectInvalid(state);
    }
  });

  it('enforces exact aggregate state bytes rather than an entry estimate', () => {
    const state = validState();
    const exactBytes = Buffer.byteLength(JSON.stringify(state));
    expect(() =>
      assertContinuationState(state, source, scopeHash, {
        ...normalizeOptions(),
        maxContinuationBytes: exactBytes,
      }),
    ).not.toThrow();
    expect(() =>
      assertContinuationState(state, source, scopeHash, {
        ...normalizeOptions(),
        maxContinuationBytes: exactBytes - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'RUN_PROTOCOL_ERROR' }));
  });
});
