import { Buffer } from 'node:buffer';
import { runManaged } from './runtime/manager.js';
import { createSignedContinuationCodec } from './continuation-codec.js';
import type {
  HostFunctionManifest,
  HostFunctions,
  ContinuationCodec,
  RunInput,
  Runner,
  RunnerOptions,
  RunResult,
} from './types.js';

function missingContinuationCodec<TOKEN>(): ContinuationCodec<TOKEN> {
  const message =
    'Continuation signing is not configured. Set RUN_CONTINUATION_SECRET or pass continuationSecret or continuationCodec to createRunner().';
  const error = (): never => {
    throw new TypeError(message);
  };
  return { decode: error, encode: error };
}

const RESERVED_GLOBALS = new Set([
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
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
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'InternalError',
  'Intl',
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
  'SharedArrayBuffer',
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
  'WebAssembly',
  'console',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'eval',
  'Function',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'performance',
  'crypto',
  'undefined',
  'unescape',
]);

const RESERVED_HOST_FUNCTION_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'then',
]);

const HOST_FUNCTION_IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/u;

const assertEnumerableProperties = (
  value: object,
  label: (name: string) => string,
): void => {
  for (const name of Object.getOwnPropertyNames(value)) {
    if (Object.getOwnPropertyDescriptor(value, name)?.enumerable !== true) {
      throw new TypeError(`${label(name)} must be enumerable.`);
    }
  }
};

const validateHostFunctions = (
  hostFunctions: HostFunctions,
): HostFunctionManifest => {
  const hostFunctionManifest = new Map<string, ReadonlySet<string>>();
  assertEnumerableProperties(
    hostFunctions,
    namespace => `Host function namespace "${namespace}"`,
  );
  for (const [namespace, group] of Object.entries(hostFunctions)) {
    if (!Object.hasOwn(hostFunctions, namespace)) {
      continue;
    }
    if (
      Buffer.byteLength(namespace) > 512 ||
      !HOST_FUNCTION_IDENTIFIER_PATTERN.test(namespace)
    ) {
      throw new TypeError(`Invalid host function namespace: ${namespace}`);
    }
    if (
      RESERVED_GLOBALS.has(namespace) ||
      RESERVED_HOST_FUNCTION_NAMES.has(namespace) ||
      namespace.startsWith('__run')
    ) {
      throw new TypeError(`Reserved host function namespace: ${namespace}`);
    }
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      throw new TypeError(
        `Host function namespace "${namespace}" must be an object.`,
      );
    }
    const hostFunctionNames = new Set<string>();
    assertEnumerableProperties(
      group,
      name => `Host function "${namespace}.${name}"`,
    );
    for (const [name, hostFunction] of Object.entries(group)) {
      if (!Object.hasOwn(group, name)) {
        continue;
      }
      if (
        !HOST_FUNCTION_IDENTIFIER_PATTERN.test(name) ||
        Buffer.byteLength(`${namespace}.${name}`) > 1024 ||
        RESERVED_HOST_FUNCTION_NAMES.has(name) ||
        name.startsWith('__run')
      ) {
        throw new TypeError(`Invalid host function name: ${namespace}.${name}`);
      }
      if (typeof hostFunction !== 'function') {
        throw new TypeError(
          `Host function "${namespace}.${name}" must be a function.`,
        );
      }
      hostFunctionNames.add(name);
    }
    hostFunctionManifest.set(namespace, hostFunctionNames);
  }
  return hostFunctionManifest;
};

/** Creates a runner with shared defaults. */
export const createRunner = <TOKEN = string>(
  options: RunnerOptions<TOKEN> = {},
): Runner<TOKEN> => {
  if (
    options.continuationCodec !== undefined &&
    options.continuationSecret !== undefined
  ) {
    throw new TypeError(
      'Runner continuationCodec and continuationSecret cannot be used together.',
    );
  }
  const configuredSecret =
    options.continuationSecret ?? process.env.RUN_CONTINUATION_SECRET;
  const continuationCodec =
    options.continuationCodec ??
    (configuredSecret === undefined
      ? missingContinuationCodec<TOKEN>()
      : (createSignedContinuationCodec({
          secret: configuredSecret,
        }) as ContinuationCodec<TOKEN>));
  const continuationAudience = options.continuationAudience ?? 'run';
  if (
    continuationAudience.length === 0 ||
    Buffer.byteLength(continuationAudience) > 512
  ) {
    throw new TypeError(
      'Runner continuationAudience must contain between 1 and 512 bytes.',
    );
  }
  return {
    async run<OUTPUT = unknown>(
      input: RunInput<TOKEN>,
    ): Promise<RunResult<OUTPUT, TOKEN>> {
      const hostFunctions = input.hostFunctions ?? {};
      const hostFunctionManifest = validateHostFunctions(hostFunctions);
      const value = await runManaged({
        ...input,
        continuationAudience,
        continuationCodec,
        hostFunctionManifest,
        hostFunctions,
        limits: {
          ...options.limits,
          ...input.limits,
        },
      });
      return value as RunResult<OUTPUT, TOKEN>;
    },
  };
};

let defaultRunner:
  | {
      continuationSecret: string | undefined;
      runner: Runner<string>;
    }
  | undefined;

/** Executes JavaScript in a fresh, hardened QuickJS context. */
export const run = async <OUTPUT = unknown>(
  input: RunInput<string>,
): Promise<RunResult<OUTPUT, string>> => {
  const continuationSecret = process.env.RUN_CONTINUATION_SECRET;
  if (
    defaultRunner === undefined ||
    defaultRunner.continuationSecret !== continuationSecret
  ) {
    defaultRunner = {
      continuationSecret,
      runner: createRunner({
        continuationAudience: 'run',
        ...(continuationSecret === undefined ? {} : { continuationSecret }),
      }),
    };
  }
  return await defaultRunner.runner.run<OUTPUT>(input);
};
