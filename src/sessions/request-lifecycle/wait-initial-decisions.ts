import type {
  SessionApprovalDecisionReceipt,
  SessionCommitWaitCommand,
} from "./contracts.js";
import {
  hasNonemptyIdentity,
  type LifecycleMutationContext,
  type LifecycleRequest,
} from "./record-operations.js";

export function hasValidInitialApprovalDecisions(
  request: LifecycleRequest,
  command: SessionCommitWaitCommand,
): boolean {
  const decisions = command.initialDecisions ?? [];
  if (decisions.length >= command.approvals.length) return false;
  const approvals = new Set(
    command.approvals.map((approval) => approval.approvalId),
  );
  const decided = new Set<string>();
  const commands = new Set(
    request.lifecycle.decisionReceipts.map((receipt) => receipt.commandId),
  );
  for (const decision of decisions) {
    if (!approvals.has(decision.approvalId)) return false;
    if (decided.has(decision.approvalId)) return false;
    if (!hasNonemptyIdentity(decision.commandId)) return false;
    if (commands.has(decision.commandId)) return false;
    if (typeof decision.approved !== "boolean") return false;
    decided.add(decision.approvalId);
    commands.add(decision.commandId);
  }
  return true;
}

export function createInitialApprovalReceipts(
  context: LifecycleMutationContext,
  request: LifecycleRequest,
  command: SessionCommitWaitCommand,
): SessionApprovalDecisionReceipt[] {
  return (command.initialDecisions ?? []).map((decision) => ({
    ...decision,
    requestId: request.requestId,
    generation: request.generation,
    waitId: command.waitId,
    committedAt: context.timestamp,
    revision: request.lifecycle.revision,
  }));
}
