import { getHookByToken, getRun } from 'workflow/api';
import {
  approvalHookToken,
  isApprovalHookMetadata,
  type RunRoundOutcome,
} from '../domain/types.js';
import { HttpError, requireActor } from './auth.js';

export const getAutomation = async (
  request: Request,
  automationId: string,
  runId: string,
): Promise<Response> => {
  const actor = requireActor(request, 'tenant-user');
  const run = getRun<RunRoundOutcome>(runId);
  if (!(await run.exists))
    throw new HttpError(404, 'Automation was not found.');

  const status = await run.status;
  if (status === 'completed') {
    return Response.json({ status, result: await run.returnValue });
  }
  if (status === 'failed' || status === 'cancelled') {
    return Response.json({ status });
  }

  try {
    const hook = await getHookByToken(approvalHookToken(automationId));
    const metadata: unknown = hook.metadata;
    if (
      !isApprovalHookMetadata(metadata) ||
      metadata.automationId !== automationId ||
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
