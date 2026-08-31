import { describe, expect, it } from 'vitest';
import { requireAutomationOwner } from '../src/api/automation-identity.js';
import { createApprovalUrl } from '../src/steps/publish-approval-request.js';

process.env.RUN_CONTINUATION_SECRET =
  'test-secret-that-is-at-least-32-bytes-long';

describe('approval notification', () => {
  it('links to the UI with its signed public ID and run ID', async () => {
    const url = new URL(
      await createApprovalUrl(
        {
          kind: 'order-approval',
          automationKey: 'automation-key',
          tenantId: 'tenant_demo',
          round: 1,
          requests: [],
        },
        'run_123',
      ),
    );

    const automationId = url.searchParams.get('automation');
    expect(automationId).not.toBeNull();
    expect(url.searchParams.get('run')).toBe('run_123');
    expect(
      requireAutomationOwner(automationId!, 'tenant_demo', 'run_123'),
    ).toEqual({ automationKey: 'automation-key', runId: 'run_123' });
  });
});
