import { requireAutomationResultCapacity } from "./result-capacity.js";
import type {
  AutomationExecutionRecord, AutomationJournalState, AutomationResultRecord,
} from "./storage-records.js";

/** A deadline can interrupt admission before its definite no-dispatch receipt returns. */
export function settleTerminalUndispatchedAdmission(input: {
  state: AutomationJournalState;
  execution: AutomationExecutionRecord;
  nodeId: string;
  invocationId: string | undefined;
  result: AutomationResultRecord | undefined;
  resultKind: "node_output" | "effect_receipt";
  maxStoredArtifactBytes: number | undefined;
  now: number;
}): void {
  const { state, execution, result } = input;
  const node = execution.nodes.find((item) => item.nodeId === input.nodeId);
  const hasInterruptedAdmission = Boolean(execution.reportRef) && node?.status === "interrupted";
  if (!hasInterruptedAdmission) throw new Error("automation_run_locked");
  const hasDirectAttemptMismatch = input.resultKind === "node_output" &&
    node?.attemptId !== input.invocationId;
  if (hasDirectAttemptMismatch) throw new Error("automation_attempt_mismatch");
  const attemptIndex = state.attempts.findIndex((item) => item.runId === execution.id &&
    item.nodeId === input.nodeId && item.invocationId === input.invocationId);
  const attempt = state.attempts[attemptIndex];
  if (!attempt) throw new Error("automation_attempt_mismatch");
  if (attempt.state === "settled") throw new Error("automation_attempt_mismatch");
  if (attempt.lateSettlement) throw new Error("automation_attempt_mismatch");
  const hasBoundReceipt = result?.runId === execution.id && result.nodeId === input.nodeId &&
    result.kind === input.resultKind;
  if (!hasBoundReceipt) throw new Error("automation_result_ref_invalid");
  const usedBytes = state.results.filter((item) => item.runId === execution.id)
    .reduce((total, item) => total + item.sizeBytes, result.sizeBytes);
  const exceedsRunArtifactBudget = input.maxStoredArtifactBytes !== undefined &&
    usedBytes > input.maxStoredArtifactBytes;
  if (exceedsRunArtifactBudget) throw new Error("automation_artifact_budget_exhausted");
  requireAutomationResultCapacity(state, result.sizeBytes);
  state.results.push(result);
  state.attempts[attemptIndex] = { ...attempt, state: "settled",
    settledAt: new Date(input.now).toISOString(), settlementRef: result.id };
  // Preserve the historical terminal node/report; only its attempt evidence advances.
  const executionIndex = state.executions.findIndex((item) => item.id === execution.id);
  state.executions[executionIndex] = { ...execution, revision: execution.revision + 1 };
}
