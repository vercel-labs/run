import type { ApprovalHookMetadata } from '../domain/types.js';

const sign = async (value: string): Promise<string> => {
  const secret = process.env.RUN_CONTINUATION_SECRET;
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('RUN_CONTINUATION_SECRET must contain at least 32 bytes.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  );
  return btoa(String.fromCharCode(...signature))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

export const createApprovalUrl = async (
  metadata: ApprovalHookMetadata,
  workflowRunId: string,
): Promise<string> => {
  const signature = await sign(
    `automation:${metadata.tenantId}:${metadata.automationKey}:${workflowRunId}`,
  );
  const automationId = `${metadata.automationKey}.${workflowRunId}.${signature}`;
  const url = new URL('http://localhost:3000/');
  url.searchParams.set('automation', automationId);
  url.searchParams.set('run', workflowRunId);
  return url.toString();
};

export async function publishApprovalRequest(
  metadata: ApprovalHookMetadata,
  hookToken: string,
  workflowRunId: string,
): Promise<void> {
  'use step';

  // This is the local notification adapter. A real app would send an email,
  // Slack message, or inbox notification and keep the token server-side.
  console.log('\nApproval required');
  console.log(JSON.stringify(metadata, null, 2));
  console.log(`Hook token (sensitive): ${hookToken}`);
  console.log(`Open ${await createApprovalUrl(metadata, workflowRunId)}\n`);
}
