import type { CapabilityApprovalGate } from "../approval-contracts.js";
import { resolvePreparedGroupApproval } from "./approval-group.js";
import { settleAdmittedPreparedGroup } from "./settle-prepared.js";
import {
  requireRoleCallOperationSupervisionInterventionCommit,
  resolveRoleCallTransactions,
  type RoleCallCapabilityExecutionAdmission,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../../role-calls/index.js";
import type {
  WorkerCapabilityAttemptReference,
  WorkerCapabilityBatchAttemptReference,
  WorkerCapabilityExecutionFreshness,
} from "../contracts.js";
import {
  traceWorkerCapabilityExecutionCompleted,
  traceWorkerCapabilityExecutionStarted,
  traceWorkerCapabilityStateRejected,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import { WorkerCapabilityOperationSupervisionLimitError } from "../errors.js";
import { executePreparedAndNormalizeAdapter } from "./adapter-execution.js";
import type { PreparedBoundInvocation } from "./invocation-preparation.js";

export async function beginAndSettlePreparedSingle<TContext>(params: {
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  call: RoleCallFrame;
  invocation: PreparedBoundInvocation<TContext>;
  diagnostic: WorkerCapabilityDiagnosticContext;
  executionFreshness?: WorkerCapabilityExecutionFreshness;
  approvalGate?: CapabilityApprovalGate;
}): Promise<WorkerCapabilityAttemptReference> {
  const transactions = resolveRoleCallTransactions(params.ledger);
  const actionFingerprint = params.invocation.prepared.actionFingerprint;
  const admission = createExecutionAdmission(params.executionFreshness);
  const begunResult = await transactions.beginCapabilityExecution({
    expectedHead: params.currentHead,
    callId: params.call.callId,
    invocationAttempt: params.call.activationCount,
    capabilityId: params.invocation.adapter.descriptor.capabilityId,
    declaredEffect: params.invocation.adapter.descriptor.effect,
    intent: params.invocation.intent,
    controlsJson: JSON.stringify(params.invocation.prepared.acceptedControls),
    ...(actionFingerprint ? { actionFingerprint } : {}),
    ...(admission ? { admission } : {}),
  });
  if (!begunResult.ok) {
    traceStateRejection(
      params.diagnostic,
      [params.invocation],
      "begin",
      begunResult.issueCode,
    );
    throw stateRejection("begin", begunResult.issueCode);
  }
  const begun = begunResult.commit;
  if (begun.effect.type === "operation_supervision_intervened") {
    return Object.freeze({
      kind: "operation_supervision_intervened" as const,
      commit: requireRoleCallOperationSupervisionInterventionCommit(begun),
    });
  }

  const executionId = begun.effect.executionId;
  const wait = await resolvePreparedGroupApproval({
    gate: params.approvalGate,
    requestId: params.diagnostic.requestId,
    call: params.call,
    invocations: [params.invocation],
    executionIds: [executionId],
    batch: false,
    executionFreshness: params.executionFreshness,
  });
  if (wait) return wait;
  await settleAdmittedPreparedGroup({
    ledger: params.ledger,
    expectedHead: begun.head,
    call: params.call,
    invocations: [params.invocation],
    executionIds: [executionId],
    batch: false,
    diagnostic: params.diagnostic,
  });
  return Object.freeze({ executionId });
}

export async function beginAndSettlePreparedBatch<TContext>(params: {
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  call: RoleCallFrame;
  invocations: readonly PreparedBoundInvocation<TContext>[];
  diagnostic: WorkerCapabilityDiagnosticContext;
  executionFreshness?: WorkerCapabilityExecutionFreshness;
  approvalGate?: CapabilityApprovalGate;
}): Promise<WorkerCapabilityBatchAttemptReference> {
  const transactions = resolveRoleCallTransactions(params.ledger);
  const admission = createExecutionAdmission(params.executionFreshness);
  const begunResult = await transactions.beginCapabilityBatch({
    expectedHead: params.currentHead,
    callId: params.call.callId,
    invocationAttempt: params.call.activationCount,
    entries: params.invocations.map(({ adapter, intent, prepared }) => ({
      capabilityId: adapter.descriptor.capabilityId,
      declaredEffect: "observation" as const,
      intent,
      controlsJson: JSON.stringify(prepared.acceptedControls),
      ...(prepared.actionFingerprint
        ? { actionFingerprint: prepared.actionFingerprint }
        : {}),
    })),
    ...(admission ? { admission } : {}),
  });
  if (!begunResult.ok) {
    traceStateRejection(
      params.diagnostic,
      params.invocations,
      "begin",
      begunResult.issueCode,
    );
    throw stateRejection("begin", begunResult.issueCode);
  }
  const begun = begunResult.commit;
  if (begun.effect.type === "operation_supervision_intervened") {
    return Object.freeze({
      kind: "operation_supervision_intervened" as const,
      commit: requireRoleCallOperationSupervisionInterventionCommit(begun),
    });
  }

  const executionIds = begun.effect.executionIds;
  const wait = await resolvePreparedGroupApproval({
    gate: params.approvalGate,
    requestId: params.diagnostic.requestId,
    call: params.call,
    invocations: params.invocations,
    executionIds,
    batch: true,
    executionFreshness: params.executionFreshness,
  });
  if (wait) return wait;
  return settleAdmittedPreparedGroup({
    ledger: params.ledger,
    expectedHead: begun.head,
    call: params.call,
    invocations: params.invocations,
    executionIds,
    batch: true,
    diagnostic: params.diagnostic,
  });
}

function createExecutionAdmission(
  executionFreshness: WorkerCapabilityExecutionFreshness | undefined,
): RoleCallCapabilityExecutionAdmission | undefined {
  if (!executionFreshness) return undefined;
  return Object.freeze({
    isCurrent: () => executionFreshness.isCurrent(),
  });
}

function traceStateRejection<TContext>(
  diagnostic: WorkerCapabilityDiagnosticContext,
  invocations: readonly Pick<PreparedBoundInvocation<TContext>, "adapter">[],
  phase: "begin" | "settle",
  issueCode: string,
  executionIds: readonly (string | undefined)[] = [],
): void {
  invocations.forEach((invocation, index) => {
    traceWorkerCapabilityStateRejected(
      diagnostic,
      invocation.adapter.descriptor,
      {
        phase,
        issueCode,
        ...(executionIds[index] ? { executionId: executionIds[index] } : {}),
      },
    );
  });
}

function stateRejection(phase: "begin" | "settle", code: string): Error {
  if (phase === "begin" && code === "operation_supervision_limit_exceeded") {
    return new WorkerCapabilityOperationSupervisionLimitError();
  }
  return new Error(`worker_capability_${phase}_rejected:${code}`);
}
