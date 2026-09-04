import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RunBridgeLimitError,
  RunTimeoutError,
  createRunner,
  getHostFunctionContext,
} from './index.js';
import { createPromiseWithResolvers } from './utils/promise-with-resolvers.js';
import { toJsonPayload } from './utils/serialization.js';

const waitForAbort = (abortSignal: AbortSignal): Promise<null> => {
  const aborted = createPromiseWithResolvers<null>();
  if (abortSignal.aborted) {
    aborted.resolve(null);
  } else {
    abortSignal.addEventListener('abort', () => aborted.resolve(null), {
      once: true,
    });
  }
  return aborted.promise;
};

describe('synchronous host functions', () => {
  it('returns serializable values synchronously and throws synchronously', async () => {
    const runner = createRunner({
      syncHostFunctions: {
        values: {
          fail() {
            throw new Error('private failure');
          },
          async read(value: string) {
            await Promise.resolve();
            return { value };
          },
        },
      },
    });

    await expect(
      runner.run({ source: 'return values.read("ok").value;' }),
    ).resolves.toEqual({ status: 'completed', value: 'ok' });
    await expect(
      runner.run({ source: 'values.fail(); return "unreachable";' }),
    ).rejects.toMatchObject({
      code: 'RUN_HOST_FUNCTION_ERROR',
      message: 'Host function failed.',
    });
  });

  it('provides live read-after-write semantics', async () => {
    const files = new Map<string, string>();
    const runner = createRunner({
      syncHostFunctions: {
        fs: {
          readFile(path: string) {
            return files.get(path);
          },
          writeFile(path: string, value: string) {
            files.set(path, value);
          },
        },
      },
    });

    await expect(
      runner.run({
        source: 'fs.writeFile("/value", "new"); return fs.readFile("/value");',
      }),
    ).resolves.toEqual({ status: 'completed', value: 'new' });
  });

  it('shares the aggregate bridge request limit with async calls', async () => {
    const runner = createRunner({
      limits: { maxBridgeRequests: 2 },
      syncHostFunctions: { values: { read: () => 1 } },
    });

    await expect(
      runner.run({
        source: 'values.read(); values.read(); values.read(); return 1;',
      }),
    ).rejects.toBeInstanceOf(RunBridgeLimitError);
  });

  it('preserves aggregate request order across async and sync transports', async () => {
    const observed: string[] = [];
    const runner = createRunner({
      syncHostFunctions: {
        syncValues: {
          read() {
            observed.push(`sync:${getHostFunctionContext().requestIndex}`);
            return 'sync';
          },
        },
      },
    });

    await expect(
      runner.run({
        hostFunctions: {
          asyncValues: {
            read() {
              observed.push(`async:${getHostFunctionContext().requestIndex}`);
              return 'async';
            },
          },
        },
        source: `
          const pending = asyncValues.read();
          const observed = pending.then(value => value);
          await Promise.resolve();
          const immediate = syncValues.read();
          return [await observed, immediate];
        `,
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: ['async', 'sync'],
    });
    expect(observed).toEqual(['async:1', 'sync:2']);
  });

  it('does not execute a later sync request beyond the aggregate limit', async () => {
    let sideEffect = false;
    const runner = createRunner({
      limits: { maxBridgeRequests: 1 },
      syncHostFunctions: {
        effects: { write: () => (sideEffect = true) },
      },
    });

    await expect(
      runner.run({
        hostFunctions: { values: { read: () => 1 } },
        source: `
          const pending = values.read();
          const observed = pending.then(value => value);
          await Promise.resolve();
          try { effects.write(); } catch {}
          return await observed;
        `,
      }),
    ).rejects.toBeInstanceOf(RunBridgeLimitError);
    expect(sideEffect).toBe(false);
  });

  it('terminates when a synchronous binding attempts to interrupt', async () => {
    let continued = false;
    const runner = createRunner({
      syncHostFunctions: {
        gate: {
          check: () => getHostFunctionContext().interrupt('approval'),
          continued: () => (continued = true),
        },
      },
    });

    await expect(
      runner.run({
        source: `
          try { gate.check(); } catch {}
          gate.continued();
        `,
      }),
    ).rejects.toMatchObject({ code: 'RUN_PROTOCOL_ERROR' });
    expect(continued).toBe(false);
  });

  it('rejects bridge allocations outside invocation and hard memory bounds', async () => {
    await expect(
      createRunner({
        limits: {
          maxHostFunctionOutputBytes: 2 * 1024 * 1024,
          memoryLimitBytes: 1024 * 1024,
        },
        syncHostFunctions: { values: { read: () => 1 } },
      }).run({ source: 'return values.read();' }),
    ).rejects.toBeInstanceOf(RunBridgeLimitError);

    await expect(
      createRunner({
        limits: {
          maxHostFunctionOutputBytes: 128 * 1024 * 1024,
          memoryLimitBytes: 256 * 1024 * 1024,
        },
        syncHostFunctions: { values: { read: () => 1 } },
      }).run({ source: 'return values.read();' }),
    ).rejects.toBeInstanceOf(RunBridgeLimitError);
  });

  it('aborts the host context and tears down a blocked worker on timeout', async () => {
    let lateSideEffect = false;
    const started = createPromiseWithResolvers<null>();
    const observedAbort = createPromiseWithResolvers<null>();
    const runner = createRunner({
      limits: { timeoutMs: 1000 },
      syncHostFunctions: {
        operations: {
          async blocked() {
            const { abortSignal } = getHostFunctionContext();
            started.resolve(null);
            await waitForAbort(abortSignal);
            observedAbort.resolve(null);
            if (!abortSignal.aborted) {
              lateSideEffect = true;
            }
          },
        },
      },
    });

    await runner.run({ source: 'return 0;' });
    const execution = runner.run({
      source: 'operations.blocked(); return 1;',
    });
    await started.promise;
    await expect(execution).rejects.toBeInstanceOf(RunTimeoutError);
    await observedAbort.promise;
    expect(lateSideEffect).toBe(false);
  });

  it('does not expose the bridge SharedArrayBuffer to guest code', async () => {
    const runner = createRunner({
      syncHostFunctions: { values: { read: () => 1 } },
    });
    await expect(
      runner.run({
        source:
          'return [typeof SharedArrayBuffer, typeof Atomics, values.read()];',
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: ['undefined', 'undefined', 1],
    });
  });

  it('binds synchronous capabilities into continuation scope', async () => {
    const secret = 's'.repeat(32);
    const source = 'return await tools.pause();';
    const firstRunner = createRunner({
      continuationSecret: secret,
      syncHostFunctions: { safe: { read: () => 1 } },
    });
    const interrupted = await firstRunner.run({
      hostFunctions: {
        tools: {
          pause: () => getHostFunctionContext().interrupt('pause'),
        },
      },
      source,
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected the run to be interrupted.');
    }

    const changedRunner = createRunner({
      continuationSecret: secret,
      syncHostFunctions: { privileged: { write: () => {} } },
    });
    await expect(
      changedRunner.run({
        continuation: interrupted.continuation,
        hostFunctions: { tools: { pause: () => {} } },
        resolutions: [
          { interruptionId: interrupted.interruptions[0]?.id ?? '', value: 1 },
        ],
        source,
      }),
    ).rejects.toThrow(/scope|binding|continuation/iu);
  });

  it('preserves the legacy continuation scope without sync bindings', async () => {
    const source = 'return await tools.pause();';
    let actualScopeHash: string | undefined;
    const runner = createRunner({
      continuationCodec: {
        decode: () => {
          throw new Error('decode is unused');
        },
        encode(state) {
          actualScopeHash = state.scopeHash;
          return 'legacy-compatible-token';
        },
      },
    });

    await expect(
      runner.run({
        hostFunctions: {
          tools: {
            pause: () => getHostFunctionContext().interrupt('pause'),
          },
        },
        source,
      }),
    ).resolves.toMatchObject({
      continuation: 'legacy-compatible-token',
      status: 'interrupted',
    });

    const legacyScope = toJsonPayload(
      {
        audience: 'run',
        bindingManifest: ['tools.pause'],
        continuationContext: undefined,
        transformedSourceHash: createHash('sha256')
          .update(source)
          .digest('hex'),
      },
      Number.MAX_SAFE_INTEGER,
      'Continuation scope',
    );
    expect(actualScopeHash).toBe(
      createHash('sha256').update(legacyScope).digest('hex'),
    );
  });

  it('replays synchronous outcomes without repeating side effects', async () => {
    const secret = 'r'.repeat(32);
    const sideEffects: string[] = [];
    const createReplayRunner = () =>
      createRunner({
        continuationSecret: secret,
        syncHostFunctions: {
          effects: {
            write(label: string) {
              sideEffects.push(label);
              return sideEffects.length;
            },
          },
        },
      });
    const source = `
      const first = effects.write('first');
      const firstResolution = await tools.pause('first');
      const second = effects.write('second');
      const secondResolution = await tools.pause('second');
      return [first, firstResolution, second, secondResolution];
    `;
    const pause = (label: string) => {
      const context = getHostFunctionContext();
      if (context.resume !== undefined) {
        return context.resume.resolution;
      }
      return context.interrupt(label);
    };
    const first = await createReplayRunner().run({
      hostFunctions: {
        tools: {
          pause,
        },
      },
      source,
    });
    if (first.status !== 'interrupted') {
      throw new Error('Expected the run to be interrupted.');
    }
    expect(sideEffects).toEqual(['first']);

    const second = await createReplayRunner().run({
      continuation: first.continuation,
      hostFunctions: { tools: { pause } },
      resolutions: [
        {
          interruptionId: first.interruptions[0]?.id ?? '',
          value: 'approved-first',
        },
      ],
      source,
    });
    if (second.status !== 'interrupted') {
      throw new Error('Expected the resumed run to be interrupted.');
    }
    expect(sideEffects).toEqual(['first', 'second']);

    await expect(
      createReplayRunner().run({
        continuation: second.continuation,
        hostFunctions: { tools: { pause } },
        resolutions: [
          {
            interruptionId: second.interruptions[0]?.id ?? '',
            value: 'approved-second',
          },
        ],
        source,
      }),
    ).resolves.toEqual({
      status: 'completed',
      value: [1, 'approved-first', 2, 'approved-second'],
    });
    expect(sideEffects).toEqual(['first', 'second']);
  });

  it('waits for racing synchronous calls before minting its ledger', async () => {
    const sideEffects: string[] = [];
    const runner = createRunner({
      continuationSecret: 'q'.repeat(32),
      limits: { timeoutMs: 3000 },
      syncHostFunctions: {
        effects: { write: (label: string) => sideEffects.push(label) },
      },
    });

    const pause = () => {
      const context = getHostFunctionContext();
      return context.resume?.resolution ?? context.interrupt('pause');
    };
    const source =
      "const pending = tools.pause(); effects.write('a'); effects.write('b'); await pending;";
    const interrupted = await runner.run({
      hostFunctions: { tools: { pause } },
      source,
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected the run to be interrupted.');
    }
    expect(sideEffects).toEqual(['a', 'b']);
    await expect(
      runner.run({
        continuation: interrupted.continuation,
        hostFunctions: { tools: { pause } },
        resolutions: [
          {
            interruptionId: interrupted.interruptions[0]?.id ?? '',
            value: true,
          },
        ],
        source,
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(sideEffects).toEqual(['a', 'b']);
  });

  it('observes post-response synchronous calls before minting', async () => {
    const sideEffects: string[] = [];
    const runner = createRunner({
      continuationSecret: 'w'.repeat(32),
      limits: { timeoutMs: 3000 },
      syncHostFunctions: {
        effects: { write: (label: string) => sideEffects.push(label) },
      },
    });
    const pause = () => {
      const context = getHostFunctionContext();
      return context.resume?.resolution ?? context.interrupt('pause');
    };
    const source = `
      const pending = tools.pause();
      const value = await tools.fetch();
      effects.write(value + '-a');
      effects.write(value + '-b');
      await pending;
    `;
    const hostFunctions = {
      tools: {
        fetch: () => 'fetched',
        pause,
      },
    };
    const interrupted = await runner.run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected the run to be interrupted.');
    }
    expect(sideEffects).toEqual(['fetched-a', 'fetched-b']);

    await expect(
      runner.run({
        continuation: interrupted.continuation,
        hostFunctions,
        resolutions: [
          {
            interruptionId: interrupted.interruptions[0]?.id ?? '',
            value: true,
          },
        ],
        source,
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(sideEffects).toEqual(['fetched-a', 'fetched-b']);
  });

  it('bounds rejected synchronous outcomes before recording them', async () => {
    const runner = createRunner({
      continuationSecret: 'e'.repeat(32),
      limits: { maxHostFunctionOutputBytes: 32 },
      syncHostFunctions: {
        effects: {
          fail() {
            throw new Error('failure');
          },
        },
      },
    });

    await expect(
      runner.run({
        hostFunctions: {
          tools: {
            pause: () => getHostFunctionContext().interrupt('pause'),
          },
        },
        source: 'try { effects.fail(); } catch {} await tools.pause();',
      }),
    ).rejects.toThrow(
      'Synchronous host bridge error exceeds the 32 byte size limit.',
    );
  });

  it('does not retain a continuation ledger when signing is disabled', async () => {
    const previous = process.env.RUN_CONTINUATION_SECRET;
    delete process.env.RUN_CONTINUATION_SECRET;
    try {
      const runner = createRunner({
        limits: {
          maxContinuationBytes: 128,
          maxHostFunctionOutputBytes: 1024,
        },
        syncHostFunctions: {
          values: { read: () => 'x'.repeat(256) },
        },
      });

      await expect(
        runner.run({
          source: 'return values.read().length + values.read().length;',
        }),
      ).resolves.toEqual({ status: 'completed', value: 512 });
    } finally {
      if (previous === undefined) {
        delete process.env.RUN_CONTINUATION_SECRET;
      } else {
        process.env.RUN_CONTINUATION_SECRET = previous;
      }
    }
  });
});

describe('native module loading', () => {
  it('loads dynamic imports from function-body source', async () => {
    const runner = createRunner();

    await expect(
      runner.run({
        moduleLoader: {
          load(specifier) {
            if (specifier === '/value.js') {
              return "export const value = 'loaded';";
            }
            throw new Error('not found');
          },
        },
        source: `
          const module = await import('/value.js');
          return module.value;
        `,
        sourceType: 'function-body',
      }),
    ).resolves.toEqual({ status: 'completed', value: 'loaded' });
  });

  it('evaluates explicit module source without requiring a loader', async () => {
    await expect(
      createRunner().run({
        source: 'export const value = 1;',
        sourceType: 'module',
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
  });

  it('loads static, aliased, cyclic, and dynamic ESM', async () => {
    const seen: string[] = [];
    const modules = new Map<string, string>([
      [
        '/a.js',
        "import { b } from './b.js'; export function getA(){ return 'a'; } export const a = getA() + b;",
      ],
      [
        '/b.js',
        "import { getA } from './a.js'; export const b = 'b'; export const cycle = () => getA();",
      ],
      ['/dynamic.js', "export const value = 'dynamic';"],
      ['/typed.ts', 'export const typed: number = 42;'],
    ]);
    const runner = createRunner({
      syncHostFunctions: {
        report: { value: (value: string) => seen.push(value) },
      },
    });

    await expect(
      runner.run({
        moduleLoader: {
          identity: 'test-loader',
          load(specifier) {
            const source = modules.get(specifier);
            if (source === undefined) {
              throw new Error('not found');
            }
            return source;
          },
          normalize(specifier, importer) {
            if (specifier === 'alias') {
              return '/a.js';
            }
            if (specifier.startsWith('/')) {
              return specifier;
            }
            const base = importer.includes('/')
              ? importer.slice(0, importer.lastIndexOf('/'))
              : '';
            const parts = `${base}/${specifier}`.split('/');
            const normalized: string[] = [];
            for (const part of parts) {
              if (part === '..') {
                normalized.pop();
              } else if (part && part !== '.') {
                normalized.push(part);
              }
            }
            return `/${normalized.join('/')}`;
          },
        },
        source:
          "import { a } from 'alias'; import { typed } from './typed.ts'; const dynamic = await import('./dynamic.js'); report.value(a + ':' + dynamic.value + ':' + typed);",
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(seen).toEqual(['ab:dynamic:42']);
  });

  it('replays module loading without invoking the loader again', async () => {
    const runner = createRunner({ continuationSecret: 'x'.repeat(32) });
    let loads = 0;
    const pause = () => {
      const context = getHostFunctionContext();
      return context.resume?.resolution ?? context.interrupt('pause');
    };
    const moduleLoader = {
      identity: 'modules-v1',
      load() {
        loads += 1;
        return 'export const value = 1;';
      },
    };
    const source = "import './dependency.js'; await tools.pause();";
    const interrupted = await runner.run({
      hostFunctions: { tools: { pause } },
      moduleLoader,
      source,
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected the module run to be interrupted.');
    }
    expect(loads).toBe(1);
    await expect(
      runner.run({
        continuation: interrupted.continuation,
        hostFunctions: { tools: { pause } },
        moduleLoader: { ...moduleLoader, identity: 'modules-v2' },
        resolutions: [
          {
            interruptionId: interrupted.interruptions[0]?.id ?? '',
            value: true,
          },
        ],
        source,
      }),
    ).rejects.toThrow(/continuation|scope/iu);
    expect(loads).toBe(1);
    await expect(
      runner.run({
        continuation: interrupted.continuation,
        hostFunctions: { tools: { pause } },
        moduleLoader,
        resolutions: [
          {
            interruptionId: interrupted.interruptions[0]?.id ?? '',
            value: true,
          },
        ],
        source,
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(loads).toBe(1);
  });

  it('requires a stable module-loader identity for continuations', async () => {
    const runner = createRunner({ continuationSecret: 'i'.repeat(32) });
    await expect(
      runner.run({
        hostFunctions: {
          tools: {
            pause: () => getHostFunctionContext().interrupt('pause'),
          },
        },
        moduleLoader: { load: () => 'export {};' },
        source: 'await tools.pause();',
      }),
    ).rejects.toThrow('non-empty identity');
  });

  it('binds non-default source type to the continuation scope', async () => {
    const runner = createRunner({ continuationSecret: 's'.repeat(32) });
    const pause = () =>
      getHostFunctionContext().resume?.resolution ??
      getHostFunctionContext().interrupt('pause');
    const input = {
      hostFunctions: { tools: { pause } },
      moduleLoader: {
        identity: 'scope-loader',
        load: () => 'export {};',
      },
      source: 'return await tools.pause();',
    } as const;
    const interrupted = await runner.run({
      ...input,
      sourceType: 'function-body',
    });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected the function-body run to be interrupted.');
    }

    await expect(
      runner.run({
        ...input,
        continuation: interrupted.continuation,
        resolutions: [
          {
            interruptionId: interrupted.interruptions[0]?.id ?? '',
            value: true,
          },
        ],
        sourceType: 'module',
      }),
    ).rejects.toThrow(/continuation|scope/iu);
  });

  it('redacts module loader errors from guest code', async () => {
    const seen: string[] = [];
    const runner = createRunner({
      syncHostFunctions: {
        report: { error: (message: string) => seen.push(message) },
      },
    });

    await expect(
      runner.run({
        moduleLoader: {
          load() {
            const error = new Error('ENOENT: /private/tenant/secret.ts');
            Object.assign(error, { code: 'ENOENT' });
            throw error;
          },
        },
        source: `
          try {
            await import('/private/tenant/secret.ts');
          } catch (error) {
            report.error(error.message);
          }
        `,
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(seen).toEqual(['Host bridge request failed.']);
  });

  it('rejects a non-string result from a configured normalizer', async () => {
    let loaded = false;
    const runner = createRunner({
      syncHostFunctions: { report: { value: () => {} } },
    });

    await expect(
      runner.run({
        moduleLoader: {
          load() {
            loaded = true;
            return 'export {};';
          },
          normalize: () => undefined as never,
        },
        source: `
          try { await import('/forbidden.js'); } catch {}
          report.value();
        `,
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(loaded).toBe(false);
  });

  it('preserves trusted synchronous binding errors in module runs', async () => {
    const runner = createRunner({
      syncHostFunctions: {
        values: {
          fail() {
            throw new Error('private failure');
          },
        },
      },
    });

    await expect(
      runner.run({
        moduleLoader: { load: () => 'export {};' },
        source: 'values.fail();',
      }),
    ).rejects.toMatchObject({
      code: 'RUN_HOST_FUNCTION_ERROR',
      details: undefined,
      message: 'Host function failed.',
    });
  });

  it('rejects oversized module requests without desynchronizing the bridge', async () => {
    const seen: string[] = [];
    const runner = createRunner({
      limits: { maxHostFunctionArgumentsBytes: 64 },
      syncHostFunctions: {
        report: { value: (value: string) => seen.push(value) },
      },
    });

    await expect(
      runner.run({
        moduleLoader: {
          load: specifier =>
            specifier === '/ok.js'
              ? "export const value = 'ok';"
              : 'export {};',
        },
        source: `
          try { await import('x'.repeat(70_000)); } catch {}
          const loaded = await import('/ok.js');
          report.value(loaded.value);
        `,
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(seen).toEqual(['ok']);
  });

  it('preserves side-effectful imports whose bindings are unused', async () => {
    const seen: string[] = [];
    const runner = createRunner({
      syncHostFunctions: {
        report: { value: (value: string) => seen.push(value) },
      },
    });

    await expect(
      runner.run({
        moduleLoader: {
          load: specifier => {
            if (specifier === '/side.ts') {
              return "report.value('side'); export const unused: number = 1;";
            }
            throw new Error('not found');
          },
        },
        source: "import { unused } from '/side.ts';",
      }),
    ).resolves.toEqual({ status: 'completed', value: undefined });
    expect(seen).toEqual(['side']);
  });

  it('bounds encoded and transformed module source', async () => {
    const escapedSource = `export const value = ${JSON.stringify('\\'.repeat(48))};`;
    const encodedRunner = createRunner({
      limits: {
        maxHostFunctionOutputBytes: 128,
        maxSourceBytes: 512,
      },
    });
    await expect(
      encodedRunner.run({
        moduleLoader: { load: () => escapedSource },
        source: "import './escaped.js';",
      }),
    ).rejects.toThrow(
      'moduleLoader.load output exceeds the 128 byte size limit.',
    );

    const sourceRunner = createRunner({
      limits: {
        maxHostFunctionOutputBytes: 1024,
        maxSourceBytes: 128,
      },
    });
    await expect(
      sourceRunner.run({
        moduleLoader: { load: () => `/*${'x'.repeat(256)}*/ export {};` },
        source: "import './large.js';",
      }),
    ).rejects.toMatchObject({
      code: 'RUN_SOURCE_TOO_LARGE',
      message: expect.stringMatching(/source.*128 byte size limit/iu),
    });
  });

  it('aborts a blocked module loader on timeout', async () => {
    const started = createPromiseWithResolvers<null>();
    const observedAbort = createPromiseWithResolvers<null>();
    const runner = createRunner({ limits: { timeoutMs: 1000 } });

    await runner.run({ source: 'return 0;' });
    const execution = runner.run({
      moduleLoader: {
        async load() {
          const { abortSignal } = getHostFunctionContext();
          started.resolve(null);
          await waitForAbort(abortSignal);
          observedAbort.resolve(null);
          return 'export const value = 1;';
        },
      },
      source: "import './blocked.js';",
    });
    await started.promise;
    await expect(execution).rejects.toBeInstanceOf(RunTimeoutError);
    await observedAbort.promise;
  });
});
