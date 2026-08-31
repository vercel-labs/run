import { start } from 'workflow/api';
import { HttpError, requireActor } from './auth.js';
import { orderAutomationWorkflow } from '../workflow/order-automation-workflow.js';

export const startAutomation = async (request: Request): Promise<Response> => {
  const actor = requireActor(request, 'tenant-user');
  const body = (await request.json()) as { source?: unknown };
  if (typeof body.source !== 'string' || body.source.trim().length === 0) {
    throw new HttpError(400, 'source must be a non-empty string.');
  }

  const automationId = crypto.randomUUID();
  const run = await start(orderAutomationWorkflow, [
    {
      automationId,
      source: body.source,
      scope: {
        tenantId: actor.tenantId,
        policyVersion: 'refund-policy-v1',
      },
    },
  ]);

  return Response.json({ automationId, runId: run.runId }, { status: 202 });
};
