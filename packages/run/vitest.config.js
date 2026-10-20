import { configDefaults, defineConfig } from 'vitest/config';

const isBunRuntime = globalThis.Bun !== undefined;

export function createVitestConfig() {
  return defineConfig({
    test: {
      env: {
        RUN_CONTINUATION_SECRET: 'run-test-continuation-secret-32-bytes',
      },
      environment: 'node',
      exclude: configDefaults.exclude,
      // Hardening tests can starve Bun's worker scheduler when run concurrently.
      fileParallelism: !isBunRuntime,
      hookTimeout: 15_000,
      testTimeout: 15_000,
    },
  });
}
