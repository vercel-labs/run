import { createSignedContinuationCodec } from '../dist/index.js';
import { assertContinuationState } from '../dist/continuation-validation.js';
import {
  assertMainToWorkerMessage,
  assertWorkerToMainMessage,
} from '../dist/runtime/protocol-validation.js';
import { normalizeOptions } from '../dist/utils/options.js';

const iterations = positiveInteger(
  process.env.RUN_HARDENING_FUZZ_ITERATIONS,
  100_000,
);
const seed = positiveInteger(process.env.RUN_HARDENING_SEED, 1_592_594_996);
const randomModulus = 2_147_483_647;
let randomState = seed % randomModulus || 1;

const state = {
  determinism: {
    dateNowMs: 1_700_000_000_000,
    randomSeed: '01'.repeat(16),
  },
  ledger: [
    {
      bindingName: 'tools.pause',
      inputJson: '',
      interruptionId: 'interrupt-1',
      payload: { kind: 'pause' },
      status: 'interrupted',
    },
  ],
  logicalRunId: '03'.repeat(16),
  runtime: 'run-replay-v1',
  scopeHash: '02'.repeat(32),
  source: 'return await tools.pause();',
  version: 1,
};

const codec = createSignedContinuationCodec({ secret: 's'.repeat(32) });
const token = codec.encode(state);
let tokenRejections = 0;
let stateRejections = 0;
let protocolRejections = 0;
let protocolMutationRejections = 0;
const startedAt = performance.now();
const validProtocolMessages = [
  {
    direction: 'main',
    value: { invocationId: 'run-a', type: 'cancel' },
  },
  {
    direction: 'worker',
    value: { invocationId: 'run-a', type: 'ready' },
  },
  {
    direction: 'worker',
    value: {
      hostFunctionName: 'tools.echo',
      inputJson: 'null',
      invocationId: 'run-a',
      requestId: 'request-a',
      type: 'host-function-request',
    },
  },
];

for (let iteration = 0; iteration < iterations; iteration += 1) {
  const index = next() % token.length;
  const replacement = String.fromCodePoint(33 + (next() % 90));
  const mutation = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
  if (mutation !== token) {
    try {
      codec.decode(mutation);
      throw new Error(`Token mutation accepted at iteration ${iteration}.`);
    } catch (error) {
      if (error?.code !== 'RUN_PROTOCOL_ERROR') {
        throw error;
      }
      tokenRejections += 1;
    }
  }

  const malformedState = structuredClone(state);
  switch (next() % 6) {
    case 0: {
      malformedState.version = 2;
      break;
    }
    case 1: {
      malformedState.runtime = 'other';
      break;
    }
    case 2: {
      malformedState.determinism.randomSeed = String(next());
      break;
    }
    case 3: {
      malformedState.ledger[0].inputJson = '{';
      break;
    }
    case 4: {
      malformedState.ledger[0].interruptionId = `changed-${next()}`;
      break;
    }
    default: {
      malformedState.extra = generatedValue(0);
    }
  }
  try {
    assertContinuationState(
      malformedState,
      state.source,
      state.scopeHash,
      normalizeOptions(),
    );
    throw new Error(`State mutation accepted at iteration ${iteration}.`);
  } catch (error) {
    if (error?.code !== 'RUN_PROTOCOL_ERROR') {
      throw error;
    }
    stateRejections += 1;
  }

  const protocolValue = generatedValue(0);
  for (const validate of [
    value => assertMainToWorkerMessage(value),
    value => assertWorkerToMainMessage(value),
  ]) {
    try {
      validate(protocolValue);
    } catch (error) {
      if (error?.code !== 'RUN_PROTOCOL_ERROR') {
        throw error;
      }
      protocolRejections += 1;
    }
  }

  const candidate = structuredClone(
    validProtocolMessages[next() % validProtocolMessages.length],
  );
  const validateCandidate =
    candidate.direction === 'main'
      ? assertMainToWorkerMessage
      : assertWorkerToMainMessage;
  let protocolMutation = candidate.value;
  if (next() % 2 === 0) {
    const keys = Object.keys(protocolMutation);
    const removedKey = keys[next() % keys.length];
    protocolMutation = Object.fromEntries(
      Object.entries(protocolMutation).filter(([key]) => key !== removedKey),
    );
  } else {
    protocolMutation[`unexpected-${next()}`] = true;
  }
  try {
    validateCandidate(protocolMutation);
    throw new Error(`Protocol mutation accepted at iteration ${iteration}.`);
  } catch (error) {
    if (error?.code !== 'RUN_PROTOCOL_ERROR') {
      throw error;
    }
    protocolMutationRejections += 1;
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      durationMs: Math.round(performance.now() - startedAt),
      iterations,
      protocolMutationRejections,
      protocolRejections,
      seed,
      stateRejections,
      tokenRejections,
    },
    null,
    2,
  )}\n`,
);

function next() {
  randomState = (randomState * 48_271) % randomModulus;
  return randomState;
}

function generatedValue(depth) {
  const choice = next() % (depth > 2 ? 5 : 8);
  if (choice === 0) {
    return null;
  }
  if (choice === 1) {
    return next();
  }
  if (choice === 2) {
    return `value-${next()}`;
  }
  if (choice === 3) {
    return next() % 2 === 1;
  }
  if (choice === 4) {
    return;
  }
  if (choice === 5) {
    return Array.from({ length: next() % 4 }, () => generatedValue(depth + 1));
  }
  const result = {};
  for (let index = 0; index < next() % 5; index += 1) {
    result[`key-${next() % 12}`] = generatedValue(depth + 1);
  }
  return result;
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
