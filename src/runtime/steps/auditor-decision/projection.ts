import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { projectRequestSteeringSnapshot } from "../../request/request-steering.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { projectAuditorInputState } from "./audit-input-state.js";
import {
  parseExecutionAgentAuditObjective,
  type AuditorAssignment,
} from "./contracts.js";
import {
  projectAuditorEvidenceInventory,
  projectAuditorWorkEvidence,
} from "./evidence-inventory.js";

export function projectAuditorAssignment(
  request: RequestExecutionSeed,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): AuditorAssignment {
  if (!isActiveAuditorCall(request, head, call))
    throw new Error("execution_agent_auditor_call_invalid");
  const caller = head.state.calls.find(
    (candidate) => candidate.callId === call.parentCallId,
  );
  if (!isWaitingAuditorCaller(caller, call.callId))
    throw new Error("execution_agent_auditor_caller_invalid");
  const objective = parseExecutionAgentAuditObjective(call.objective!);
  const steering = projectRequestSteeringSnapshot(
    request.requestSteering,
    objective.requestSteeringVersion,
  );
  const evidence = projectAuditorWorkEvidence(head, caller!.callId);
  const state = projectAuditorInputState(
    head,
    caller!.callId,
    steering.version,
    objective.criterionIds,
    evidence,
  );
  const inventory = projectAuditorEvidenceInventory(
    head,
    caller!.callId,
    evidence,
  );
  traceDebug("runtime.auditor", "assignment.created", {
    requestId: request.requestId,
    callId: call.callId,
    callerCallId: caller!.callId,
    phase: state.pendingEvidenceIds ? "review" : "selection",
    workFingerprint: state.workFingerprint,
    inventoryCount: inventory.length,
    pendingEvidenceCount: state.pendingEvidenceIds?.length ?? 0,
  });
  return Object.freeze({
    auditId: call.callId,
    callerCallId: caller!.callId,
    target: JSON.stringify({
      kind: "runtime_active_request_intent_v1",
      authority: "user",
      currentRequest: request.prompt,
      steeringVersion: steering.version,
      updates: steering.updates.map(({ sequence, text }) => ({
        sequence,
        text,
      })),
    }),
    sourceRevision: head.revision,
    criterionIds: objective.criterionIds,
    criteria: Object.freeze(
      objective.criterionIds.map((criterionId) =>
        Object.freeze({
          criterionId,
          description:
            "The canonical settled execution evidence satisfies the exact current user request.",
        }),
      ),
    ),
    workFingerprint: state.workFingerprint,
    inventory,
    reviewedBundleFingerprints: state.reviewedBundleFingerprints,
    pendingEvidenceIds: state.pendingEvidenceIds,
    reviewedEvidenceBundles: state.reviewedEvidenceBundles,
    selectedEvidenceIds: Object.freeze([]),
    evidence: Object.freeze([]),
    availableEvidenceCount: inventory.length,
    omittedEvidenceCount: 0,
  });
}

function isActiveAuditorCall(
  request: RequestExecutionSeed,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): boolean {
  if (
    head.state.requestId !== request.requestId ||
    head.state.phase !== "running"
  )
    return false;
  if (head.state.activeCallId !== call.callId || call.status !== "active")
    return false;
  if (call.roleId !== "reviewer" || !call.parentCallId) return false;
  return Boolean(call.objective);
}

function isWaitingAuditorCaller(
  caller: RoleCallFrame | undefined,
  auditId: string,
): boolean {
  if (!caller || caller.status !== "waiting_for_child") return false;
  return caller.childCallIds.includes(auditId);
}
