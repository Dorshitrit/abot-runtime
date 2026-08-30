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
  traceWorkerCapabilityExecutionStarted(
    params.diagnostic,
    params.invocation.adapter.descriptor,
    executionId,
    params.invocation.intent.length,
    Object.keys(params.invocation.prepared.acceptedControls).length,
  );
  const execution = await executePreparedAndNormalizeAdapter({
    prepared: params.invocation.prepared,
    descriptor: params.invocation.adapter.descriptor,
    diagnostic: params.diagnostic,
    executionId,
  });
  const { result, outcomeFingerprint } = execution;
  const settledResult = await transactions.settleCapabilityExecution({
    expectedHead: begun.head,
    callId: params.call.callId,
    executionId,
    outcome: result.outcome,
    ...(outcomeFingerprint ? { outcomeFingerprint } : {}),
    observedEffect: result.observedEffect,
    summary: result.summary,
    ...(result.referenceData ? { referenceData: result.referenceData } : {}),
    ...(result.references ? { references: result.references } : {}),
    exactResult: result.exactResult,
  });
  if (!settledResult.ok) {
    traceStateRejection(
      params.diagnostic,
      [params.invocation],
      "settle",
      settledResult.issueCode,
      [executionId],
    );
    throw stateRejection("settle", settledResult.issueCode);
  }
  traceWorkerCapabilityExecutionCompleted(
    params.diagnostic,
    params.invocation.adapter.descriptor,
    result,
    executionId,
  );
  return Object.freeze({ executionId });
}

export async function beginAndSettlePreparedBatch<TContext>(params: {
  currentHead: RoleCallLedgerHead;
  ledger: RoleCallLedger;
  call: RoleCallFrame;
  invocations: readonly PreparedBoundInvocation<TContext>[];
  diagnostic: WorkerCapabilityDiagnosticContext;
  executionFreshness?: WorkerCapabilityExecutionFreshness;
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
  params.invocations.forEach((invocation, index) => {
    traceWorkerCapabilityExecutionStarted(
      params.diagnostic,
      invocation.adapter.descriptor,
      executionIds[index]!,
      invocation.intent.length,
      Object.keys(invocation.prepared.acceptedControls).length,
    );
  });
  const executions = await Promise.all(
    params.invocations.map((invocation, index) =>
      executePreparedAndNormalizeAdapter({
        prepared: invocation.prepared,
        descriptor: invocation.adapter.descriptor,
        diagnostic: params.diagnostic,
        executionId: executionIds[index]!,
      }),
    ),
  );
  const settledResult = await transactions.settleCapabilityBatch({
    expectedHead: begun.head,
    callId: params.call.callId,
    settlements: executions.map(({ result, outcomeFingerprint }, index) => ({
      executionId: executionIds[index]!,
      outcome: result.outcome,
      ...(outcomeFingerprint ? { outcomeFingerprint } : {}),
      observedEffect: result.observedEffect,
      summary: result.summary,
      ...(result.referenceData ? { referenceData: result.referenceData } : {}),
      ...(result.references ? { references: result.references } : {}),
      exactResult: result.exactResult,
    })),
  });
  if (!settledResult.ok) {
    traceStateRejection(
      params.diagnostic,
      params.invocations,
      "settle",
      settledResult.issueCode,
      executionIds,
    );
    throw stateRejection("settle", settledResult.issueCode);
  }
  params.invocations.forEach((invocation, index) => {
    traceWorkerCapabilityExecutionCompleted(
      params.diagnostic,
      invocation.adapter.descriptor,
      executions[index]!.result,
      executionIds[index]!,
    );
  });
  return Object.freeze({ executionIds: Object.freeze([...executionIds]) });
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
