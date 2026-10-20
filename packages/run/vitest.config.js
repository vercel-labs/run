import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import {
  buildGuestSerdeSource,
  buildInlineWorkerSource,
} from './scripts/build-runtime-sources.mjs';

const workerPath = fileURLToPath(
  new URL('src/runtime/worker.ts', import.meta.url),
);
const workerSourcePath = fileURLToPath(
  new URL('src/runtime/worker-source.ts', import.meta.url),
).replaceAll('\\', '/');
const guestSerdeSourcePath = fileURLToPath(
  new URL('src/runtime/guest-serde-source.ts', import.meta.url),
).replaceAll('\\', '/');

const runtimeSources = {
  async load(id) {
    if (id !== workerSourcePath && id !== guestSerdeSourcePath) {
      return;
    }

    const guestSerde = await buildGuestSerdeSource();
    const { source, watchFiles } =
      id === workerSourcePath
        ? await buildInlineWorkerSource(workerPath, guestSerde)
        : guestSerde;

    // These dependencies are embedded strings, so Vite cannot discover them
    // through imports. Register every input to invalidate and rerun on edits.
    for (const file of watchFiles) {
      this.addWatchFile(file);
    }

    const name =
      id === workerSourcePath
        ? 'INLINE_RUN_WORKER_SOURCE'
        : 'GUEST_SERDE_SOURCE';
    return `export const ${name} = ${JSON.stringify(source)};`;
  },
  name: 'run-runtime-sources',
};

export default defineConfig(({ mode }) => {
  const testPackage = mode === 'package';
  return {
    plugins: testPackage ? [] : [runtimeSources],
    resolve: {
      alias: testPackage
        ? [
            {
              // Runtime modules and tests one directory above must use the
              // same built worker when exercising the package.
              find: /^\.\/(?:runtime\/)?worker-source\.js$/u,
              replacement: fileURLToPath(
                new URL('dist/runtime/worker-source.js', import.meta.url),
              ),
            },
          ]
        : [],
    },
    test: {
      env: {
        RUN_CONTINUATION_SECRET: 'run-test-continuation-secret-32-bytes',
      },
      environment: 'node',
      exclude: testPackage
        ? configDefaults.exclude
        : [...configDefaults.exclude, 'src/runtime/bundled-runtime.test.ts'],
      // Hardening tests can starve Bun's worker scheduler when run concurrently.
      fileParallelism: globalThis.Bun === undefined,
      hookTimeout: 15_000,
      include: ['src/**/*.test.ts'],
      testTimeout: 15_000,
    },
  };
});
