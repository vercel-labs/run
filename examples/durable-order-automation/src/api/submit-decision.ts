import { getHookByToken, resumeHook } from 'workflow/api';
import {
  approvalHookToken,
  createRunResolutions,
  isApprovalHookMetadata,
  type ApprovalBatch,
  type ApprovalDecision,
} from '../domain/types.js';
import { HttpError, requireActor } from './auth.js';

const parseDecisions = (value: unknown): ApprovalDecision[] => {
  if (!Array.isArray(value))
    throw new HttpError(400, 'decisions must be an array.');
  return value.map(item => {
    if (typeof item !== 'object' || item === null) {
      throw new HttpError(400, 'Each decision must be an object.');
    }
    const candidate = item as Partial<ApprovalDecision>;
    if (
      typeof candidate.interruptionId !== 'string' ||
      typeof candidate.approved !== 'boolean'
    ) {
      throw new HttpError(400, 'Decision fields are invalid.');
    }
    return {
      interruptionId: candidate.interruptionId,
      approved: candidate.approved,
    };
  });
};

export const submitDecision = async (
  request: Request,
  automationId: string,
): Promise<Response> => {
  const actor = requireActor(request, 'approver');
  const body = (await request.json()) as { decisions?: unknown };
  const token = approvalHookToken(automationId);
  const hook = await getHookByToken(token);
  const metadata: unknown = hook.metadata;

  if (
    !isApprovalHookMetadata(metadata) ||
    metadata.automationId !== automationId ||
    metadata.tenantId !== actor.tenantId
  ) {
    throw new HttpError(403, 'You cannot approve this automation.');
  }

  const batch: ApprovalBatch = {
    decisions: parseDecisions(body.decisions),
    decidedBy: actor.userId,
  };

  try {
    createRunResolutions(metadata.requests, batch);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : 'Decision batch is invalid.',
    );
  }

  await resumeHook(token, batch);
  return Response.json({ accepted: true, runId: hook.runId });
};
