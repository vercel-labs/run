import { RunError, type RunInterruption, type RunResolution } from 'run';
import type {
  ApprovalRequest,
  AutomationScope,
  RunRoundOutcome,
} from '../domain/types.js';
import { createOrderRunner } from '../sandbox/create-order-runner.js';
import { createOrderHostFunctions } from '../sandbox/order-host-functions.js';

interface RunAutomationRoundInput {
  source: string;
  scope: AutomationScope;
  continuation?: string;
  resolutions?: RunResolution[];
}

const parseApprovalRequest = (
  interruption: RunInterruption,
): ApprovalRequest => {
  if (
    typeof interruption.payload !== 'object' ||
    interruption.payload === null
  ) {
    throw new Error('Refund interruption payload must be an object.');
  }
  const payload = interruption.payload as Record<string, unknown>;
  if (
    payload.kind !== 'refund-approval' ||
    payload.action !== 'refund' ||
    typeof payload.orderId !== 'string' ||
    typeof payload.amount !== 'number'
  ) {
    throw new Error('Refund interruption payload is invalid.');
  }
  return {
    id: interruption.id,
    hostFunctionName: interruption.hostFunctionName,
    action: 'refund',
    orderId: payload.orderId,
    amount: payload.amount,
  };
};

const retryableRunCodes = new Set([
  'RUN_ABORTED',
  'RUN_CONCURRENCY_LIMIT',
  'RUN_HOST_FUNCTION_ERROR',
]);

export async function runAutomationRound(
  input: RunAutomationRoundInput,
): Promise<RunRoundOutcome> {
  'use step';

  try {
    const result = await createOrderRunner().run({
      source: input.source,
      hostFunctions: createOrderHostFunctions(input.scope),
      continuationContext: input.scope,
      continuation: input.continuation,
      resolutions: input.resolutions,
    });

    if (result.status === 'completed') {
      return { status: 'completed', value: result.value };
    }

    return {
      status: 'interrupted',
      continuation: result.continuation,
      interruptions: result.interruptions.map(parseApprovalRequest),
    };
  } catch (error) {
    if (!RunError.isInstance(error) || retryableRunCodes.has(error.code)) {
      throw error;
    }
    return {
      status: 'failed',
      error: { code: error.code, message: error.message },
    };
  }
}
