import assert from 'node:assert/strict';
import { run } from '../dist/index.js';

const javascriptResult = await run({
  source: 'return 40 + 2;',
});
assert.deepEqual(javascriptResult, {
  status: 'completed',
  value: 42,
});

const typescriptAndHostFunctionResult = await run({
  hostFunctions: {
    math: {
      values: () => [20, 22],
    },
  },
  source: `
    const values: number[] = await math.values();
    return values.reduce((total: number, value: number) => total + value, 0);
  `,
});
assert.deepEqual(typescriptAndHostFunctionResult, {
  status: 'completed',
  value: 42,
});

await assert.rejects(
  run({
    limits: { timeoutMs: 250 },
    source: 'while (true) {}',
  }),
  { code: 'RUN_TIMEOUT' },
);
assert.deepEqual(await run({ source: 'return 1;' }), {
  status: 'completed',
  value: 1,
});
