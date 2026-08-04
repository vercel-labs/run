import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      RUN_CONTINUATION_SECRET: 'run-test-continuation-secret-32-bytes',
    },
    environment: 'node',
    exclude: configDefaults.exclude,
    hookTimeout: 15_000,
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
