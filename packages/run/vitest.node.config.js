import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

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
    hookTimeout: 15_000,
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
