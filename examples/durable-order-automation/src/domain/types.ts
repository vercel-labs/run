import type { RunResolution } from 'run';

export interface AutomationScope {
  tenantId: string;
  policyVersion: string;
}

export interface AutomationInput {
  automationId: string;
  source: string;
  scope: AutomationScope;
}

export interface ApprovalRequest {
  id: string;
  hostFunctionName: string;
  action: 'refund';
  orderId: string;
  amount: number;
}

export interface ApprovalDecision {
  interruptionId: string;
  approved: boolean;
}

export interface ApprovalBatch {
  decisions: ApprovalDecision[];
  decidedBy: string;
}

export interface SafeRunError {
  code: string;
  message: string;
}

export type RunRoundOutcome =
  | { status: 'completed'; value: unknown }
  | {
      status: 'interrupted';
      continuation: string;
      interruptions: ApprovalRequest[];
    }
  | { status: 'failed'; error: SafeRunError };

export interface ApprovalHookMetadata {
  kind: 'order-approval';
  automationId: string;
  tenantId: string;
  round: number;
  requests: ApprovalRequest[];
}

export const approvalHookToken = (automationId: string): string =>
  `order-approval:${automationId}`;

export const createRunResolutions = (
  requests: ApprovalRequest[],
  batch: ApprovalBatch,
): RunResolution[] => {
  const decisions = new Map<string, ApprovalDecision>();

  for (const decision of batch.decisions) {
    if (decisions.has(decision.interruptionId)) {
      throw new Error(
        `Duplicate decision for interruption "${decision.interruptionId}".`,
      );
    }
    decisions.set(decision.interruptionId, decision);
  }

  const requestIds = new Set(requests.map(request => request.id));
  for (const id of decisions.keys()) {
    if (!requestIds.has(id)) {
      throw new Error(`Unknown interruption "${id}".`);
    }
  }

  return requests.map(request => {
    const decision = decisions.get(request.id);
    if (!decision) {
      throw new Error(`Missing decision for interruption "${request.id}".`);
    }
    return {
      interruptionId: request.id,
      value: {
        approved: decision.approved,
        decidedBy: batch.decidedBy,
      },
    };
  });
};

export const isApprovalHookMetadata = (
  value: unknown,
): value is ApprovalHookMetadata => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ApprovalHookMetadata>;
  return (
    candidate.kind === 'order-approval' &&
    typeof candidate.automationId === 'string' &&
    typeof candidate.tenantId === 'string' &&
    typeof candidate.round === 'number' &&
    Array.isArray(candidate.requests)
  );
};
