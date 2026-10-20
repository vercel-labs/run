import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import {
  buildGuestSerdeSource,
  buildInlineWorkerSource,
} from './scripts/build-runtime-sources.mjs';
import { createVitestConfig } from './vitest.config.js';

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

export default mergeConfig(createVitestConfig(), {
  plugins: [runtimeSources],
  test: {
    exclude: ['src/runtime/bundled-runtime.test.ts'],
    include: ['src/**/*.test.ts'],
  },
});
