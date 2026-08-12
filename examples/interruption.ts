import { createInterface } from 'node:readline/promises';
import { createRunner, getHostFunctionContext } from 'run';

const continuationSecret = process.env.RUN_CONTINUATION_SECRET;
if (!continuationSecret) {
  throw new Error(
    'RUN_CONTINUATION_SECRET is required. Generate one with: export RUN_CONTINUATION_SECRET="$(openssl rand -base64 32)"',
  );
}

const runner = createRunner({
  continuationSecret,
});

let renderCalls = 0;
let sendCalls = 0;

const input = {
  source: `
    const message = await newsletter.render("August update");
    return await newsletter.send(message);
  `,
  hostFunctions: {
    newsletter: {
      render: (title: string) => {
        renderCalls += 1;
        return `Newsletter: ${title}`;
      },
      send: (message: string) => {
        const context = getHostFunctionContext();
        const { resume } = context;

        if (resume === undefined) {
          context.interrupt({
            kind: 'approval',
            message: `Send "${message}"?`,
          });
        } else if (resume.resolution !== true) {
          return { sent: false };
        }

        sendCalls += 1;
        return { sent: true, message };
      },
    },
  },
};

const interrupted = await runner.run(input);

if (interrupted.status !== 'interrupted') {
  throw new Error('Expected the run to request approval.');
}

console.log('The sandbox paused with:', interrupted.interruptions[0]?.payload);

const prompt = createInterface({
  input: process.stdin,
  output: process.stdout,
});
const answer = await prompt.question('Approve? (y/N) ');
prompt.close();

const approved = answer.trim().toLowerCase() === 'y';
const completed = await runner.run({
  ...input,
  continuation: interrupted.continuation,
  resolutions: interrupted.interruptions.map(interruption => ({
    interruptionId: interruption.id,
    value: approved,
  })),
});

console.log('Resumed result:', completed);
console.log({ renderCalls, sendCalls });
