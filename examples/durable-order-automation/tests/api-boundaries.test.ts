import { describe, expect, it } from 'vitest';
import {
  createApprovalHookToken,
  createAutomationId,
  createAutomationKey,
  requireAutomationOwner,
} from '../src/api/automation-identity.js';
import { completedOutcomeResponse } from '../src/api/get-automation.js';
import {
  MAX_SOURCE_BYTES,
  startAutomation,
} from '../src/api/start-automation.js';

process.env.RUN_CONTINUATION_SECRET =
  'test-secret-that-is-at-least-32-bytes-long';

describe('API boundaries', () => {
  it('binds automation IDs to their tenant', () => {
    const automationKey = createAutomationKey();
    const automationId = createAutomationId(
      'tenant_demo',
      automationKey,
      'run_123',
    );
    expect(() =>
      requireAutomationOwner(automationId, 'tenant_demo', 'run_123'),
    ).not.toThrow();
    expect(() => requireAutomationOwner(automationId, 'tenant_other')).toThrow(
      'does not belong',
    );
    expect(() =>
      requireAutomationOwner(automationId, 'tenant_demo', 'run_other'),
    ).toThrow('does not belong');
  });

  it('derives a secret hook token that is not the public automation ID', () => {
    const automationKey = createAutomationKey();
    const automationId = createAutomationId(
      'tenant_demo',
      automationKey,
      'run_123',
    );
    const token = createApprovalHookToken(automationKey);
    expect(token).toMatch(/^order-approval:/u);
    expect(token).not.toContain(automationId);
  });

  it('rejects oversized source before starting a workflow', async () => {
    const request = new Request('http://localhost/api/automations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-demo-role': 'tenant-user',
      },
      body: JSON.stringify({ source: 'x'.repeat(MAX_SOURCE_BYTES + 1) }),
    });

    await expect(startAutomation(request)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('reports a terminal Run outcome as failed', async () => {
    const response = completedOutcomeResponse({
      status: 'failed',
      error: { code: 'RUN_ERROR', message: 'Invalid source.' },
    });
    await expect(response.json()).resolves.toEqual({
      status: 'failed',
      error: { code: 'RUN_ERROR', message: 'Invalid source.' },
    });
  });
});
