import {
  projectWorkerSettledCapabilityResults,
} from "../../orchestration/worker-capabilities/index.js";
import type {
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  type WorkerCapabilityResumeContext,
} from "./contracts.js";

export function projectWorkerCapabilityResumeContext(
  ledger: RoleCallLedger,
  head: RoleCallLedgerHead,
  refs: Readonly<{ callId: string }> &
    (Readonly<{ executionId: string }> | Readonly<{ executionIds: readonly string[] }>),
): WorkerCapabilityResumeContext {
  if (ledger.current() !== head) {
    throw new Error("worker_capability_resume_head_stale");
  }
  const call = head.state.calls.find(
    (candidate) => candidate.callId === refs.callId,
  );
  if (
    head.state.phase !== "running" ||
    head.state.activeCallId !== refs.callId ||
    call?.roleId !== "worker" ||
    call.status !== "active" ||
    call.parentCallId === null ||
    call.callId !== refs.callId
  ) {
    throw new Error("worker_capability_resume_projection_invalid");
  }
  const settledResults = projectWorkerSettledCapabilityResults({
    ledger,
    head,
    call,
  });
  const executionIds =
    "executionIds" in refs ? refs.executionIds : [refs.executionId];
  const returnedExecutions = settledResults.slice(-executionIds.length);
  if (
    executionIds.length === 0 ||
    new Set(executionIds).size !== executionIds.length ||
    returnedExecutions.length !== executionIds.length ||
    !returnedExecutions.every(
      (execution, index) =>
        execution.executionId === executionIds[index] &&
        execution.invocationAttempt + 1 === call.activationCount,
    )
  ) {
    throw new Error("worker_capability_resume_projection_invalid");
  }
  return "executionIds" in refs
    ? Object.freeze({
        requestId: head.state.requestId,
        returnedExecutionIds: Object.freeze([...executionIds]),
        settledResults,
      })
    : Object.freeze({
        requestId: head.state.requestId,
        returnedExecutionId: executionIds[0]!,
        settledResults,
      });
}
