import { performance } from 'node:perf_hooks';
import { createRunner, getHostFunctionContext, run } from '../dist/index.js';

const iterations = positiveInteger(process.env.RUN_BENCHMARK_ITERATIONS, 100);
const budgets = {
  coldRunMs: 500,
  hostFunctionRoundTripP99Ms: 75,
  interruptAndReplayP99Ms: 300,
  tenHostFunctionRoundTripsP99Ms: 100,
  warmRunP99Ms: 75,
};
const results = Object.create(null);
const continuationRunner = createRunner({
  continuationSecret: 'run-benchmark-continuation-secret',
});

results.coldRunMs = await measureOnce(() => run({ source: 'return 1;' }));
results.warmRunMs = await measureMany(iterations, () =>
  run({ source: 'return 1;' }),
);
results.hostFunctionRoundTripMs = await measureMany(iterations, () =>
  run({
    hostFunctions: { tools: { echo: input => input } },
    source: 'return await tools.echo({ value: 1 });',
  }),
);
results.tenHostFunctionRoundTripsMs = await measureMany(iterations, () =>
  run({
    hostFunctions: { tools: { echo: input => input } },
    source: `
      const values = [];
      for (let index = 0; index < 10; index++) values.push(await tools.echo(index));
      return values;
    `,
  }),
);
results.interruptAndReplayMs = await measureMany(
  Math.max(10, Math.floor(iterations / 5)),
  async () => {
    const source = 'return await tools.pause();';
    const hostFunctions = {
      tools: {
        pause: () => {
          const context = getHostFunctionContext();
          if (!context.resume) {
            context.interrupt({ kind: 'pause' });
          }
          return context.resume.resolution;
        },
      },
    };
    const interrupted = await continuationRunner.run({ hostFunctions, source });
    if (interrupted.status !== 'interrupted') {
      throw new Error('Expected pause.');
    }
    await continuationRunner.run({
      continuation: interrupted.continuation,
      hostFunctions,
      resolutions: [
        { interruptionId: interrupted.interruptions[0].id, value: true },
      ],
      source,
    });
  },
);

assertBudget('cold run', results.coldRunMs, budgets.coldRunMs);
assertBudget('warm run p99', results.warmRunMs.p99, budgets.warmRunP99Ms);
assertBudget(
  'host function round trip p99',
  results.hostFunctionRoundTripMs.p99,
  budgets.hostFunctionRoundTripP99Ms,
);
assertBudget(
  'ten host function round trips p99',
  results.tenHostFunctionRoundTripsMs.p99,
  budgets.tenHostFunctionRoundTripsP99Ms,
);
assertBudget(
  'interrupt and replay p99',
  results.interruptAndReplayMs.p99,
  budgets.interruptAndReplayP99Ms,
);

process.stdout.write(
  `${JSON.stringify(
    {
      budgets,
      iterations,
      memory: process.memoryUsage(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      results,
    },
    null,
    2,
  )}\n`,
);

async function measureOnce(operation) {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

async function measureMany(count, operation) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(await measureOnce(operation));
  }
  samples.sort((left, right) => left - right);
  return {
    count,
    max: samples.at(-1),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    median: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

function percentile(values, percentileValue) {
  return values[
    Math.min(
      values.length - 1,
      Math.ceil((percentileValue / 100) * values.length) - 1,
    )
  ];
}

function assertBudget(label, value, budget) {
  if (value > budget) {
    throw new Error(`${label} took ${value}ms; budget is ${budget}ms.`);
  }
}

function positiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`Expected a positive integer, received ${value}.`);
  }
  return parsed;
}
