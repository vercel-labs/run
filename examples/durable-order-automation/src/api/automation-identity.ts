import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError } from './auth.js';

const getDemoSecret = (): string => {
  const secret = process.env.RUN_CONTINUATION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('RUN_CONTINUATION_SECRET must contain at least 32 bytes.');
  }
  return secret;
};

const sign = (value: string): string =>
  createHmac('sha256', getDemoSecret()).update(value).digest('base64url');

export interface AutomationIdentity {
  automationKey: string;
  runId: string;
}

export const createAutomationKey = (): string => randomUUID();

export const createAutomationId = (
  tenantId: string,
  automationKey: string,
  runId: string,
): string =>
  `${automationKey}.${runId}.${sign(
    `automation:${tenantId}:${automationKey}:${runId}`,
  )}`;

export const requireAutomationOwner = (
  automationId: string,
  tenantId: string,
  expectedRunId?: string,
): AutomationIdentity => {
  const [automationKey, runId, encodedSignature, ...extra] =
    automationId.split('.');
  if (
    !automationKey ||
    !runId ||
    !encodedSignature ||
    extra.length > 0 ||
    (expectedRunId !== undefined && runId !== expectedRunId)
  ) {
    throw new HttpError(403, 'Automation does not belong to this tenant.');
  }

  const signature = Buffer.from(encodedSignature);
  const expected = Buffer.from(
    sign(`automation:${tenantId}:${automationKey}:${runId}`),
  );
  if (
    signature.byteLength !== expected.byteLength ||
    !timingSafeEqual(signature, expected)
  ) {
    throw new HttpError(403, 'Automation does not belong to this tenant.');
  }
  return { automationKey, runId };
};

export const createApprovalHookToken = (automationKey: string): string =>
  `order-approval:${sign(`approval:${automationKey}`)}`;
