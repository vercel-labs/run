import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const isBunRuntime = typeof globalThis.Bun !== 'undefined';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: './worker-source.js',
        replacement: fileURLToPath(
          new URL('dist/runtime/worker-source.js', import.meta.url),
        ),
      },
    ],
  },
  test: {
    env: {
      RUN_CONTINUATION_SECRET: 'run-test-continuation-secret-32-bytes',
    },
    environment: 'node',
    exclude: configDefaults.exclude,
    // These tests deliberately saturate and terminate worker threads. Running
    // hardening files concurrently can starve Bun's worker scheduler long
    // enough for an otherwise healthy recovery run to hit its runtime timeout.
    fileParallelism: !isBunRuntime,
    hookTimeout: 15_000,
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
