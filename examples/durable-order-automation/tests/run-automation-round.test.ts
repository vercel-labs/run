import { beforeEach, describe, expect, it } from 'vitest';
import { orderStore } from '../src/domain/order-store.js';
import { createRunResolutions } from '../src/domain/types.js';
import { runAutomationRound } from '../src/steps/run-automation-round.js';

const scope = {
  tenantId: 'tenant_demo',
  policyVersion: 'refund-policy-v1',
};

const approve = (interruptionId: string, approved = true) => [
  {
    interruptionId,
    value: { approved, decidedBy: 'test_approver' },
  },
];

describe('runAutomationRound', () => {
  beforeEach(() => {
    process.env.RUN_CONTINUATION_SECRET =
      'test-secret-that-is-at-least-32-bytes-long';
    orderStore.reset();
  });

  it('completes source that needs no approval', async () => {
    const outcome = await runAutomationRound({
      source: 'return 6 * 7;',
      scope,
    });
    expect(outcome).toEqual({ status: 'completed', value: 42 });
  });

  it('interrupts before refunding and refunds once after approval', async () => {
    const source = `
      const order = await orders.get("order_123");
      return await orders.refund(order.id, 25);
    `;
    const interrupted = await runAutomationRound({ source, scope });
    expect(interrupted.status).toBe('interrupted');
    expect(orderStore.stats()).toMatchObject({ reads: 1, refunds: 0 });
    if (interrupted.status !== 'interrupted') return;

    const completed = await runAutomationRound({
      source,
      scope,
      continuation: interrupted.continuation,
      resolutions: approve(interrupted.interruptions[0]!.id),
    });

    expect(completed.status).toBe('completed');
    expect(orderStore.stats()).toMatchObject({ reads: 1, refunds: 1 });
  });

  it('does not refund after rejection', async () => {
    const source = 'return await orders.refund("order_123", 25);';
    const interrupted = await runAutomationRound({ source, scope });
    if (interrupted.status !== 'interrupted')
      throw new Error('Expected interruption.');

    const completed = await runAutomationRound({
      source,
      scope,
      continuation: interrupted.continuation,
      resolutions: approve(interrupted.interruptions[0]!.id, false),
    });

    expect(completed).toMatchObject({
      status: 'completed',
      value: { approved: false, refunded: false },
    });
    expect(orderStore.stats().refunds).toBe(0);
  });

  it('handles a later interruption round', async () => {
    const source = `
      await orders.refund("order_123", 25);
      return await orders.refund("order_456", 10);
    `;
    const first = await runAutomationRound({ source, scope });
    if (first.status !== 'interrupted')
      throw new Error('Expected first interruption.');
    const second = await runAutomationRound({
      source,
      scope,
      continuation: first.continuation,
      resolutions: approve(first.interruptions[0]!.id),
    });
    expect(second.status).toBe('interrupted');
    if (second.status !== 'interrupted') return;
    const completed = await runAutomationRound({
      source,
      scope,
      continuation: second.continuation,
      resolutions: approve(second.interruptions[0]!.id),
    });
    expect(completed.status).toBe('completed');
    expect(orderStore.stats().refunds).toBe(2);
  });

  it('returns all parallel interruptions as one batch', async () => {
    const outcome = await runAutomationRound({
      source: `
        return await Promise.all([
          orders.refund("order_123", 25),
          orders.refund("order_456", 10),
        ]);
      `,
      scope,
    });
    expect(outcome.status).toBe('interrupted');
    if (outcome.status !== 'interrupted') return;
    expect(outcome.interruptions).toHaveLength(2);
    expect(orderStore.stats().refunds).toBe(0);
  });

  it('fails safely when continuation scope changes', async () => {
    const source = 'return await orders.refund("order_123", 25);';
    const interrupted = await runAutomationRound({ source, scope });
    if (interrupted.status !== 'interrupted')
      throw new Error('Expected interruption.');
    const failed = await runAutomationRound({
      source,
      scope: { ...scope, tenantId: 'tenant_other' },
      continuation: interrupted.continuation,
      resolutions: approve(interrupted.interruptions[0]!.id),
    });
    expect(failed.status).toBe('failed');
  });
});

describe('createRunResolutions', () => {
  const requests = [
    {
      id: 'interrupt_1',
      hostFunctionName: 'orders.refund',
      action: 'refund' as const,
      orderId: 'order_123',
      amount: 25,
    },
  ];

  it('requires one decision for every interruption', () => {
    expect(() =>
      createRunResolutions(requests, {
        decisions: [],
        decidedBy: 'approver_1',
      }),
    ).toThrow('Missing decision');
  });

  it('rejects unknown interruption IDs', () => {
    expect(() =>
      createRunResolutions(requests, {
        decisions: [{ interruptionId: 'unknown', approved: true }],
        decidedBy: 'approver_1',
      }),
    ).toThrow('Unknown interruption');
  });
});
