import { start } from 'workflow/api';
import {
  createApprovalHookToken,
  createAutomationId,
  createAutomationKey,
} from './automation-identity.js';
import { HttpError, requireActor } from './auth.js';
import { readBoundedJson } from './read-bounded-json.js';
import { orderAutomationWorkflow } from '../workflow/order-automation-workflow.js';

export const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_REQUEST_BODY_BYTES = 2 * MAX_SOURCE_BYTES;

export const startAutomation = async (request: Request): Promise<Response> => {
  const actor = requireActor(request, 'tenant-user');
  const body = await readBoundedJson<{ source?: unknown }>(
    request,
    MAX_REQUEST_BODY_BYTES,
  );
  if (typeof body.source !== 'string' || body.source.trim().length === 0) {
    throw new HttpError(400, 'source must be a non-empty string.');
  }
  if (new TextEncoder().encode(body.source).byteLength > MAX_SOURCE_BYTES) {
    throw new HttpError(
      413,
      `source must not exceed ${MAX_SOURCE_BYTES} bytes.`,
    );
  }

  const automationKey = createAutomationKey();
  const run = await start(orderAutomationWorkflow, [
    {
      automationKey,
      approvalHookToken: createApprovalHookToken(automationKey),
      source: body.source,
      scope: {
        tenantId: actor.tenantId,
        policyVersion: 'refund-policy-v1',
      },
    },
  ]);

  const automationId = createAutomationId(
    actor.tenantId,
    automationKey,
    run.runId,
  );
  return Response.json({ automationId, runId: run.runId }, { status: 202 });
};
