import { run } from 'run';

const result = await run({
  source: `
    const doubled = await tools.double(21);
    return { message: "Hello from the sandbox!", doubled };
  `,
  hostFunctions: {
    tools: {
      double: (value: number) => value * 2,
    },
  },
});

if (result.status === 'completed') {
  console.log(result.value);
} else {
  console.log('The run was interrupted:', result.interruptions);
}
