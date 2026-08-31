import { getHostFunctionContext, type HostFunctions } from 'run';
import { orderStore } from '../domain/order-store.js';
import type { AutomationScope } from '../domain/types.js';

interface RefundResolution {
  approved: boolean;
  decidedBy: string;
}

const parseRefundResolution = (value: unknown): RefundResolution => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Refund resolution must be an object.');
  }
  const candidate = value as Partial<RefundResolution>;
  if (
    typeof candidate.approved !== 'boolean' ||
    typeof candidate.decidedBy !== 'string'
  ) {
    throw new Error('Refund resolution is invalid.');
  }
  return {
    approved: candidate.approved,
    decidedBy: candidate.decidedBy,
  };
};

export const createOrderHostFunctions = (
  scope: AutomationScope,
): HostFunctions => ({
  orders: {
    get: async (orderId: string) =>
      await orderStore.getForTenant(scope.tenantId, orderId),

    refund: async (orderId: string, amount: number) => {
      const context = getHostFunctionContext();

      // Interrupt before the protected side effect. Do not catch this signal.
      if (context.resume === undefined) {
        context.interrupt({
          kind: 'refund-approval',
          action: 'refund',
          orderId,
          amount,
        });
      }

      const resume = context.resume;
      if (resume === undefined) {
        throw new Error('Refund host function resumed without a resolution.');
      }

      const resolution = parseRefundResolution(resume.resolution);
      if (!resolution.approved) {
        return { approved: false, refunded: false };
      }

      return await orderStore.refundOnce({
        tenantId: scope.tenantId,
        orderId,
        amount,
        idempotencyKey: [context.logicalRunId, resume.interruptionId].join(':'),
      });
    },
  },
});
