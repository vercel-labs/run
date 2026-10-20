import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const quickjsWasmPath = require.resolve('quickjs-wasi/quickjs.wasm');

export const buildInlineWorkerSource = async (workerPath, guestSerde) => {
  const result = await build({
    bundle: true,
    conditions: ['browser'],
    entryPoints: [workerPath],
    external: ['node:*'],
    format: 'esm',
    legalComments: 'none',
    metafile: true,
    minify: true,
    platform: 'node',
    plugins: guestSerde
      ? [
          {
            name: 'run-guest-serde',
            setup(builder) {
              builder.onLoad(
                // esbuild uses Go regular expressions, which do not support /u.
                // oxlint-disable-next-line require-unicode-regexp
                { filter: /[/\\]guest-serde-source\.[jt]s$/ },
                () => ({
                  contents: `export const GUEST_SERDE_SOURCE = ${JSON.stringify(guestSerde.source)};`,
                  loader: 'js',
                }),
              );
            },
          },
        ]
      : [],
    sourcemap: false,
    target: 'node22',
    write: false,
  });

  if (result.outputFiles.length !== 1) {
    throw new Error(
      `Expected one inline worker bundle output, received ${result.outputFiles.length}.`,
    );
  }

  const quickJsWasm = await readFile(quickjsWasmPath);
  if (!hasWasmMagic(quickJsWasm)) {
    throw new Error(`QuickJS WASM asset is invalid: ${quickjsWasmPath}`);
  }
  const source = [
    `globalThis.__RUN_QUICKJS_WASM_BASE64__ = ${JSON.stringify(quickJsWasm.toString('base64'))};`,
    result.outputFiles[0].text.trim(),
  ].join('\n\n');
  assertBundledInlineWorkerSource(source);
  return {
    source,
    watchFiles: [
      ...Object.keys(result.metafile.inputs).map(path => resolve(path)),
      ...(guestSerde?.watchFiles ?? []),
      quickjsWasmPath,
    ],
  };
};

export const buildGuestSerdeSource = async () => {
  const entryPoint = fileURLToPath(
    new URL('guest-serde-entry.mjs', import.meta.url),
  );
  const result = await build({
    bundle: true,
    entryPoints: [entryPoint],
    format: 'iife',
    globalName: '__runSerdeBundle',
    legalComments: 'none',
    metafile: true,
    minify: true,
    platform: 'browser',
    sourcemap: false,
    target: 'es2022',
    write: false,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(
      `Expected one guest serde output, received ${result.outputFiles.length}.`,
    );
  }
  return {
    source: result.outputFiles[0].text.trim(),
    watchFiles: Object.keys(result.metafile.inputs).map(path => resolve(path)),
  };
};

const assertBundledInlineWorkerSource = source => {
  if (!source.includes('__RUN_QUICKJS_WASM_BASE64__')) {
    throw new Error('Inline worker source is missing the embedded WASM bytes.');
  }

  const forbiddenPatterns = [
    [/\brequire\(/u, 'CommonJS require'],
    [/\bimport\(/u, 'dynamic import'],
    [/\bcreateRequire\b/u, 'createRequire'],
    [
      /["']quickjs-wasi\/quickjs\.wasm["']/u,
      'quickjs-wasi WASM package specifier',
    ],
    [/node_modules\/\.pnpm/u, 'absolute pnpm node_modules path'],
  ];

  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(source)) {
      throw new Error(`Inline worker bundle still contains ${label}.`);
    }
  }
};

const hasWasmMagic = bytes =>
  bytes.length >= 4 &&
  bytes[0] === 0 &&
  bytes[1] === 97 &&
  bytes[2] === 115 &&
  bytes[3] === 109;
