import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import { createVitestConfig } from './vitest.config.js';

export default mergeConfig(createVitestConfig(), {
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
    include: ['src/runtime/bundled-runtime.test.ts'],
  },
});
