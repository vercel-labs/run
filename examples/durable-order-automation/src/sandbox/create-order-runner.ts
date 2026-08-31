import { createRunner } from 'run';

export const CONTINUATION_AUDIENCE = 'durable-order-automation-v1';

export const createOrderRunner = () => {
  const continuationSecret = process.env.RUN_CONTINUATION_SECRET;
  if (!continuationSecret) {
    throw new Error('RUN_CONTINUATION_SECRET is required.');
  }

  return createRunner({
    continuationAudience: CONTINUATION_AUDIENCE,
    continuationSecret,
    limits: {
      timeoutMs: 10_000,
      memoryLimitBytes: 32 * 1024 * 1024,
    },
  });
};
