import { defineConfig } from 'tsup';

export default defineConfig([
  {
    bundle: false,
    dts: false,
    entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/utils/serde.ts'],
    format: ['esm'],
    platform: 'node',
    sourcemap: true,
    target: 'es2022',
  },
  {
    bundle: true,
    dts: false,
    entry: { 'utils/serde': 'src/utils/serde.ts' },
    format: ['esm'],
    noExternal: ['devalue'],
    platform: 'node',
    sourcemap: true,
    target: 'es2022',
  },
  {
    dts: {
      only: true,
    },
    entry: {
      index: 'src/index.ts',
      'runtime/worker-source': 'src/runtime/worker-source.ts',
    },
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
  },
]);
