import { getHookByToken, getRun } from 'workflow/api';
import {
  createApprovalHookToken,
  requireAutomationOwner,
} from './automation-identity.js';
import {
  isApprovalHookMetadata,
  type RunRoundOutcome,
} from '../domain/types.js';
import { HttpError, requireActor } from './auth.js';

export const completedOutcomeResponse = (
  outcome: RunRoundOutcome,
): Response => {
  if (outcome.status === 'failed') {
    return Response.json({ status: 'failed', error: outcome.error });
  }
  if (outcome.status === 'interrupted') {
    return Response.json({
      status: 'failed',
      error: {
        code: 'UNEXPECTED_TERMINAL_INTERRUPTION',
        message: 'Workflow completed with an unresolved interruption.',
      },
    });
  }
  return Response.json({ status: 'completed', result: outcome.value });
};

export const getAutomation = async (
  request: Request,
  automationId: string,
  runId: string,
): Promise<Response> => {
  const actor = requireActor(request, 'tenant-user');
  const { automationKey } = requireAutomationOwner(
    automationId,
    actor.tenantId,
    runId,
  );
  const run = getRun<RunRoundOutcome>(runId);
  if (!(await run.exists))
    throw new HttpError(404, 'Automation was not found.');

  const status = await run.status;
  if (status === 'completed') {
    return completedOutcomeResponse(await run.returnValue);
  }
  if (status === 'failed' || status === 'cancelled') {
    return Response.json({ status });
  }

  try {
    const hook = await getHookByToken(createApprovalHookToken(automationKey));
    const metadata: unknown = hook.metadata;
    if (
      !isApprovalHookMetadata(metadata) ||
      metadata.automationId !== automationKey ||
      metadata.tenantId !== actor.tenantId ||
      hook.runId !== runId
    ) {
      throw new HttpError(403, 'Approval does not belong to this automation.');
    }
    return Response.json({
      status: 'waiting_for_approval',
      round: metadata.round,
      requests: metadata.requests,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return Response.json({ status });
  }
};
