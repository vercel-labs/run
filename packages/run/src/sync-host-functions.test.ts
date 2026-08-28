import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  RunBridgeLimitError,
  RunTimeoutError,
  createRunner,
  getHostFunctionContext,
} from './index.js';

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
    ).rejects.toThrow('Host function failed.');
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

  it('aborts the host context and tears down a blocked worker on timeout', async () => {
    let lateSideEffect = false;
    let observedAbort = false;
    const runner = createRunner({
      limits: { timeoutMs: 200 },
      syncHostFunctions: {
        operations: {
          async blocked() {
            const { abortSignal } = getHostFunctionContext();
            await once(abortSignal, 'abort');
            observedAbort = true;
            if (!abortSignal.aborted) {
              lateSideEffect = true;
            }
          },
        },
      },
    });

    await expect(
      runner.run({ source: 'operations.blocked(); return 1;' }),
    ).rejects.toBeInstanceOf(RunTimeoutError);
    await delay(20);
    expect(observedAbort).toBe(true);
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
});

describe('native module loading', () => {
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

  it('does not allow module-backed runs to create continuations', async () => {
    const runner = createRunner({ continuationSecret: 'x'.repeat(32) });
    await expect(
      runner.run({
        hostFunctions: {
          tools: {
            pause() {
              getHostFunctionContext().interrupt('pause');
            },
          },
        },
        moduleLoader: { load: () => 'export {};' },
        source: 'await tools.pause();',
      }),
    ).rejects.toThrow('cannot create a continuation');
  });

  it('aborts a blocked module loader on timeout', async () => {
    let observedAbort = false;
    const runner = createRunner({ limits: { timeoutMs: 200 } });

    await expect(
      runner.run({
        moduleLoader: {
          async load() {
            const { abortSignal } = getHostFunctionContext();
            await once(abortSignal, 'abort');
            observedAbort = true;
            return 'export const value = 1;';
          },
        },
        source: "import './blocked.js';",
      }),
    ).rejects.toBeInstanceOf(RunTimeoutError);
    expect(observedAbort).toBe(true);
  });
});
