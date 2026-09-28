import {
  resolveRoleCallTransactions,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCallFrame,
} from "../../role-calls/index.js";
import {
  traceWorkerCapabilityExecutionStarted,
  traceWorkerCapabilityExecutionCompleted,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import type { PreparedBoundInvocation } from "./invocation-preparation.js";
import { executePreparedAndNormalizeAdapter } from "./adapter-execution.js";

/** Shared dispatch and settlement for freshly admitted and restored exact actions. */
export async function settleAdmittedPreparedGroup<TContext>(params: {
  ledger: RoleCallLedger;
  expectedHead: RoleCallLedgerHead;
  call: RoleCallFrame;
  invocations: readonly PreparedBoundInvocation<TContext>[];
  executionIds: readonly string[];
  batch: boolean;
  diagnostic: WorkerCapabilityDiagnosticContext;
}) {
  params.invocations.forEach((invocation, index) => {
    traceWorkerCapabilityExecutionStarted(
      params.diagnostic,
      invocation.adapter.descriptor,
      params.executionIds[index]!,
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
        executionId: params.executionIds[index]!,
      }),
    ),
  );
  const settlements = executions.map(
    ({ result, outcomeFingerprint }, index) => ({
      executionId: params.executionIds[index]!,
      outcome: result.outcome,
      ...(outcomeFingerprint ? { outcomeFingerprint } : {}),
      observedEffect: result.observedEffect,
      summary: result.summary,
      ...(result.referenceData ? { referenceData: result.referenceData } : {}),
      ...(result.references ? { references: result.references } : {}),
      exactResult: result.exactResult,
    }),
  );
  const transactions = resolveRoleCallTransactions(params.ledger);
  const settled = params.batch
    ? await transactions.settleCapabilityBatch({
        expectedHead: params.expectedHead,
        callId: params.call.callId,
        settlements,
      })
    : await transactions.settleCapabilityExecution({
        expectedHead: params.expectedHead,
        callId: params.call.callId,
        ...settlements[0]!,
      });
  if (!settled.ok)
    throw new Error("worker_capability_settle_rejected:" + settled.issueCode);
  params.invocations.forEach((invocation, index) =>
    traceWorkerCapabilityExecutionCompleted(
      params.diagnostic,
      invocation.adapter.descriptor,
      executions[index]!.result,
      params.executionIds[index]!,
    ),
  );
  return Object.freeze({
    executionIds: Object.freeze([...params.executionIds]),
  });
}
