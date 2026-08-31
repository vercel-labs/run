import { createRunner, createSignedContinuationCodec } from 'run';

export const CONTINUATION_AUDIENCE = 'durable-order-automation-v1';
export const CONTINUATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const createOrderRunner = () => {
  const continuationSecret = process.env.RUN_CONTINUATION_SECRET;
  if (!continuationSecret) {
    throw new Error('RUN_CONTINUATION_SECRET is required.');
  }

  return createRunner({
    continuationAudience: CONTINUATION_AUDIENCE,
    continuationCodec: createSignedContinuationCodec({
      secret: continuationSecret,
      maxAgeMs: CONTINUATION_MAX_AGE_MS,
    }),
    limits: {
      timeoutMs: 10_000,
      memoryLimitBytes: 32 * 1024 * 1024,
    },
  });
};
