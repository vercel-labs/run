import { describe, expect, it } from 'vitest';
import { RunDetachedBridgeRequestError } from './errors.js';
import { getBindingContext, run } from './index.js';
import type { Bindings } from './index.js';

async function value(source: string, bindings?: Bindings): Promise<unknown> {
  const result = await run({
    source,
    ...(bindings === undefined ? {} : { bindings }),
  });
  if (result.status !== 'completed') {
    throw new Error('Unexpected interruption.');
  }
  return result.value;
}

function expectValue(source: string, bindings?: Bindings) {
  return expect(value(source, bindings));
}

const LOCKED_GUEST_GLOBALS = [
  'BigInt64Array',
  'BigUint64Array',
  'FinalizationRegistry',
  'Float16Array',
  'InternalError',
  'Iterator',
  'JSON',
  'Math',
  'Promise',
  'Proxy',
  'Reflect',
  'Symbol',
  'WeakRef',
  'console',
  'globalThis',
] as const;

describe('guest sandbox hardening', () => {
  it('exposes only the reviewed global surface', async () => {
    await expectValue(
      'return Object.getOwnPropertyNames(globalThis).sort();',
    ).resolves.toEqual([
      'AggregateError',
      'Array',
      'ArrayBuffer',
      'BigInt',
      'BigInt64Array',
      'BigUint64Array',
      'Boolean',
      'DataView',
      'Date',
      'Error',
      'EvalError',
      'FinalizationRegistry',
      'Float16Array',
      'Float32Array',
      'Float64Array',
      'Function',
      'Infinity',
      'Int16Array',
      'Int32Array',
      'Int8Array',
      'InternalError',
      'Iterator',
      'JSON',
      'Map',
      'Math',
      'NaN',
      'Number',
      'Object',
      'Promise',
      'Proxy',
      'RangeError',
      'ReferenceError',
      'Reflect',
      'RegExp',
      'Set',
      'String',
      'Symbol',
      'SyntaxError',
      'TypeError',
      'URIError',
      'Uint16Array',
      'Uint32Array',
      'Uint8Array',
      'Uint8ClampedArray',
      'WeakMap',
      'WeakRef',
      'WeakSet',
      '__runAssertNoDetachedBridgeCalls',
      '__runCreateBridgePromise',
      '__runSerializeJsonPayload',
      'console',
      'decodeURI',
      'decodeURIComponent',
      'encodeURI',
      'encodeURIComponent',
      'escape',
      'eval',
      'globalThis',
      'isFinite',
      'isNaN',
      'parseFloat',
      'parseInt',
      'undefined',
      'unescape',
    ]);
  });

  it('does not expose ambient host authority or nondeterministic APIs', async () => {
    await expectValue(`
      return Object.fromEntries([
        'process', 'require', 'module', 'Buffer', 'fetch', 'XMLHttpRequest',
        'WebSocket', 'crypto', 'performance', 'setTimeout', 'setInterval',
        'queueMicrotask', 'WebAssembly', 'SharedArrayBuffer', 'Deno', 'Bun'
      ].map(name => [name, typeof globalThis[name]]));
    `).resolves.toEqual({
      Buffer: 'undefined',
      Bun: 'undefined',
      Deno: 'undefined',
      SharedArrayBuffer: 'undefined',
      WebAssembly: 'undefined',
      WebSocket: 'undefined',
      XMLHttpRequest: 'undefined',
      crypto: 'undefined',
      fetch: 'undefined',
      module: 'undefined',
      performance: 'undefined',
      process: 'undefined',
      queueMicrotask: 'undefined',
      require: 'undefined',
      setInterval: 'undefined',
      setTimeout: 'undefined',
    });
  });

  it('blocks the dynamic-code constructor corpus', async () => {
    const results = (await value(`
      const results = [];
      for (const attempt of [
        () => eval('1'),
        () => (0, eval)('1'),
        () => globalThis.eval('1'),
        () => Function('return 1')(),
        () => new Function('return 1')(),
        () => Reflect.construct(Function, ['return 1'])(),
        () => (async function(){}).constructor('return 1')(),
        () => Object.getPrototypeOf(async function(){}).constructor('return 1')(),
        () => (function*(){}).constructor('yield 1')().next(),
        () => Object.getPrototypeOf(function*(){}).constructor('yield 1')().next(),
        () => (async function*(){}).constructor('yield 1')().next(),
        () => Object.getPrototypeOf(async function*(){}).constructor('yield 1')().next(),
        () => (() => {}).constructor('return 1')(),
        () => (function(){}).bind(null).constructor('return 1')(),
        () => (class {}).constructor('return 1')(),
        () => Object.constructor('return 1')(),
        () => Object.getPrototypeOf(Function).constructor('return 1')(),
        () => console.log.constructor('return 1')(),
        () => Object.getPrototypeOf(console.log).constructor('return 1')(),
        () => globalThis.constructor.constructor('return 1')()
      ]) {
        try { attempt(); results.push('allowed'); }
        catch (error) { results.push(String(error.message)); }
      }
      return results;
    `)) as string[];
    expect(results).toHaveLength(20);
    expect(results).not.toContain('allowed');
  });

  it('rejects dynamic module loading', async () => {
    await expect(
      run({ source: "return await import('node:fs');" }),
    ).rejects.toThrow();
  });

  it('freezes builtins, binding proxies, and internal helpers', async () => {
    await expectValue(
      `
      const attempts = [
        () => { Object.prototype.polluted = true; },
        () => { Array.prototype.polluted = true; },
        () => { Promise.prototype.polluted = true; },
        () => { JSON.parse = () => ({ polluted: true }); },
        () => { Math.random = () => 1; },
        () => { Date.now = () => 1; },
        () => { globalThis.Map = function FakeMap() {}; },
        () => { globalThis.Set = function FakeSet() {}; },
        () => { globalThis.__runSerializeJsonPayload = () => '"polluted"'; },
        () => { tools = {}; },
      ];
      for (const attempt of attempts) { try { attempt(); } catch {} }
      return {
        object: Boolean(({}).polluted),
        array: Boolean([].polluted),
        promise: Boolean(Promise.prototype.polluted),
        json: JSON.parse('{"ok":true}'),
        randomWasReplaced: Math.random() === 1,
        dateWasReplaced: Date.now() === 1,
        mapName: Map.name,
        setName: Set.name,
        toolsType: typeof tools,
      };
      `,
      { tools: { ok: () => true } },
    ).resolves.toMatchObject({
      array: false,
      dateWasReplaced: false,
      json: { ok: true },
      mapName: 'Map',
      object: false,
      promise: false,
      randomWasReplaced: false,
      setName: 'Set',
      toolsType: 'function',
    });
  });

  it('locks every privileged guest global binding', async () => {
    const results = (await value(`
      const realmGlobal = globalThis;
      return ${JSON.stringify(LOCKED_GUEST_GLOBALS)}.map(name => {
        const original = realmGlobal[name];
        try { realmGlobal[name] = { replaced: true }; } catch {}
        const descriptor = Object.getOwnPropertyDescriptor(realmGlobal, name);
        return {
          name,
          configurable: descriptor.configurable,
          writable: descriptor.writable,
          unchanged: realmGlobal[name] === original,
        };
      });
    `)) as {
      configurable: boolean;
      name: string;
      unchanged: boolean;
      writable: boolean;
    }[];

    expect(results).toEqual(
      LOCKED_GUEST_GLOBALS.map(name => ({
        configurable: false,
        name,
        unchanged: true,
        writable: false,
      })),
    );
  });

  it('uses trusted intrinsics after attempted guest replacement', async () => {
    await expectValue(
      `
        try { globalThis.Math = { trunc() { throw new Error('fake Math'); } }; } catch {}
        try { globalThis.Promise = { resolve() { throw new Error('fake Promise'); } }; } catch {}
        try { globalThis.Proxy = function FakeProxy() { throw new Error('fake Proxy'); }; } catch {}
        try { globalThis.Reflect = { construct() { throw new Error('fake Reflect'); } }; } catch {}
        try { globalThis.Symbol = { toStringTag: 'then' }; } catch {}

        const explicitDate = new Date(123).getTime();
        const echoed = await tools.echo('ok');
        return { echoed, explicitDate };
      `,
      { tools: { echo: (input: unknown) => input } },
    ).resolves.toEqual({ echoed: 'ok', explicitDate: 123 });
  });

  it('does not invoke guest Error prototype setters for runtime errors', async () => {
    await expect(
      run({
        bindings: { tools: { echo: () => 'ok' } },
        source: `
          for (const name of ['name', 'code', 'details']) {
            Object.defineProperty(Error.prototype, name, {
              configurable: true,
              set() { throw new Error('intercepted ' + name); },
            });
          }
          tools.echo();
          return true;
        `,
      }),
    ).rejects.toBeInstanceOf(RunDetachedBridgeRequestError);
  });

  it('starts with a clean realm after mutation, failure, and interruption', async () => {
    await expectValue(`
      try { Object.prototype.leaked = 'yes'; } catch {}
      try { globalThis.leaked = 'yes'; } catch {}
      return true;
    `).resolves.toBe(true);

    await expect(
      run({ source: "throw new Error('terminal');" }),
    ).rejects.toThrow('terminal');

    const interrupted = await run({
      bindings: {
        tools: {
          pause: () => getBindingContext().interrupt({ kind: 'pause' }),
        },
      },
      source: 'return await tools.pause();',
    });
    expect(interrupted.status).toBe('interrupted');

    await expectValue(`
      return {
        object: ({}).leaked,
        global: globalThis.leaked,
      };
    `).resolves.toEqual({});
  });

  it('does not allow guest errors to forge reserved runtime codes', async () => {
    await expect(
      run({
        source: `
          const error = new Error('guest failure');
          error.code = 'RUN_TIMEOUT';
          error.details = { timeoutMs: 1 };
          throw error;
        `,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_ERROR',
      details: { timeoutMs: 1 },
      message: 'guest failure',
    });
  });

  it.each([
    'Object',
    'Promise',
    'JSON',
    'Math',
    'Date',
    'Iterator',
    'InternalError',
    'console',
    'globalThis',
  ])('rejects a binding namespace that collides with %s', async namespace => {
    await expect(
      run({
        bindings: { [namespace]: { call: () => true } },
        source: 'return 1;',
      }),
    ).rejects.toThrow('Reserved binding namespace');
  });

  it.each(['__proto__', 'constructor', 'prototype', 'then'])(
    'rejects the reserved binding namespace %s',
    async namespace => {
      await expect(
        run({
          bindings: { [namespace]: { call: () => true } },
          source: 'return 1;',
        }),
      ).rejects.toThrow(`Reserved binding namespace: ${namespace}`);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype', 'then', '__runBridge'])(
    'rejects the dangerous declared binding name %s',
    async name => {
      const group = Object.create(null) as Record<string, () => boolean>;
      Object.defineProperty(group, name, {
        enumerable: true,
        value: () => true,
      });
      await expect(
        run({ bindings: { tools: group }, source: 'return 1;' }),
      ).rejects.toThrow('Invalid binding name');
    },
  );

  it.each([
    '',
    '1call',
    'call-name',
    'call.name',
    'call name',
    'call\nname',
    '\0call',
    'café',
    '🔧',
  ])('rejects the invalid binding name %j', async name => {
    await expect(
      run({
        bindings: { tools: { [name]: () => true } },
        source: 'return 1;',
      }),
    ).rejects.toThrow('Invalid binding name');
  });

  it.each(['call', '_call', '$call', 'call2'])(
    'accepts the valid binding name %s',
    async name => {
      await expectValue(`return await tools[${JSON.stringify(name)}]();`, {
        tools: { [name]: () => true },
      }).resolves.toBe(true);
    },
  );
});
