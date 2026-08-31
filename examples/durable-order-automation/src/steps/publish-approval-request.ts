import type { ApprovalHookMetadata } from '../domain/types.js';

export async function publishApprovalRequest(
  metadata: ApprovalHookMetadata,
  hookToken: string,
): Promise<void> {
  'use step';

  // This is the local notification adapter. A real app would send an email,
  // Slack message, or inbox notification and keep the token server-side.
  console.log('\nApproval required');
  console.log(JSON.stringify(metadata, null, 2));
  console.log(`Hook token (sensitive): ${hookToken}`);
  console.log(
    `Open http://localhost:3000/?automation=${metadata.automationId}\n`,
  );
}
