import { createHook, getWorkflowMetadata, type HookOptions } from 'workflow';
import {
  createRunResolutions,
  type ApprovalBatch,
  type ApprovalHookMetadata,
  type AutomationInput,
  type RunRoundOutcome,
} from '../domain/types.js';
import { publishApprovalRequest } from '../steps/publish-approval-request.js';
import { runAutomationRound } from '../steps/run-automation-round.js';

export async function orderAutomationWorkflow(
  input: AutomationInput,
): Promise<RunRoundOutcome> {
  'use workflow';

  const { workflowRunId } = getWorkflowMetadata();
  let outcome = await runAutomationRound({
    source: input.source,
    scope: input.scope,
  });
  let round = 1;

  while (outcome.status === 'interrupted') {
    const metadata: ApprovalHookMetadata = {
      kind: 'order-approval',
      automationKey: input.automationKey,
      tenantId: input.scope.tenantId,
      round,
      requests: outcome.interruptions,
    };

    using approval = createHook<ApprovalBatch>({
      token: input.approvalHookToken,
      metadata: metadata as unknown as HookOptions['metadata'],
    });

    await publishApprovalRequest(metadata, approval.token, workflowRunId);
    const decision = await approval;

    outcome = await runAutomationRound({
      source: input.source,
      scope: input.scope,
      continuation: outcome.continuation,
      resolutions: createRunResolutions(outcome.interruptions, decision),
    });
    round += 1;
  }

  return outcome;
}
