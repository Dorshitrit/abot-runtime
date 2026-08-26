import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { projectRequestSteeringSnapshot } from "../../request/request-steering.js";
import {
  AUDITOR_DECISION_EVIDENCE_LIMIT,
  AUDITOR_DECISION_EVIDENCE_TOTAL_MAX_CHARS,
  EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID,
  parseExecutionAgentAuditObjective,
  type AuditorAssignment,
  type AuditorCapabilityEvidence,
  type AuditorCriterion,
  type AuditorEvidence,
} from "./contracts.js";

export function projectAuditorAssignment(
  request: RequestExecutionSeed,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): AuditorAssignment {
  if (
    head.state.requestId !== request.requestId ||
    head.state.phase !== "running" ||
    head.state.activeCallId !== call.callId ||
    call.roleId !== "reviewer" ||
    call.status !== "active" ||
    !call.parentCallId ||
    !call.objective
  ) {
    throw new Error("execution_agent_auditor_call_invalid");
  }
  const caller = head.state.calls.find(
    (candidate) => candidate.callId === call.parentCallId,
  );
  if (
    !caller ||
    caller.status !== "waiting_for_child" ||
    !caller.childCallIds.includes(call.callId)
  ) {
    throw new Error("execution_agent_auditor_caller_invalid");
  }
  const objective = parseExecutionAgentAuditObjective(call.objective);
  const steeringSnapshot = projectRequestSteeringSnapshot(
    request.requestSteering,
    objective.requestSteeringVersion,
  );
  const criteria = objective.criterionIds.map(projectCriterion);
  const candidates: AuditorEvidence[] = [
    ...head.state.capabilityExecutions
      .filter(
        (execution) =>
          execution.callId === caller.callId && execution.status === "settled",
      )
      .map(projectCapabilityEvidence),
    ...head.state.results
      .filter((result) => {
        const producer = head.state.calls.find(
          (candidate) => candidate.callId === result.producerCallId,
        );
        return (
          producer?.parentCallId === caller.callId &&
          producer.callId !== call.callId
        );
      })
      .map((result) =>
        Object.freeze({
          kind: "subordinate_result" as const,
          resultRef: result.resultRef,
          producerCallId: result.producerCallId,
          roleId: result.roleId,
          outcome: result.outcome,
          summary: result.summary,
        }),
      ),
  ];
  const evidence = admitExactEvidence(candidates);
  return deepFreeze({
    auditId: call.callId,
    callerCallId: caller.callId,
    target: JSON.stringify({
      kind: "runtime_active_request_intent_v1",
      authority: "user",
      currentRequest: request.prompt,
      steeringVersion: steeringSnapshot.version,
      updates: steeringSnapshot.updates.map(({ sequence, text }) => ({
        sequence,
        text,
      })),
    }),
    sourceRevision: head.revision,
    criterionIds: [...objective.criterionIds],
    criteria,
    evidence,
    availableEvidenceCount: candidates.length,
    omittedEvidenceCount: candidates.length - evidence.length,
  });
}

function projectCriterion(criterionId: string): AuditorCriterion {
  if (criterionId !== EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID) {
    throw new Error("execution_agent_auditor_criterion_invalid");
  }
  return Object.freeze({
    criterionId,
    description:
      "The canonical settled execution evidence satisfies the exact current user request.",
  });
}

function projectCapabilityEvidence(
  execution: RoleCapabilityExecution,
): AuditorCapabilityEvidence {
  if (
    execution.status !== "settled" ||
    execution.outcome === null ||
    execution.observedEffect === null ||
    execution.summary === null ||
    execution.exactResult === undefined
  ) {
    throw new Error("execution_agent_auditor_evidence_invalid");
  }
  return deepFreeze({
    kind: "capability_result" as const,
    executionId: execution.executionId,
    capabilityId: execution.capabilityId,
    declaredEffect: execution.declaredEffect,
    outcome: execution.outcome,
    observedEffect: execution.observedEffect,
    summary: execution.summary,
    ...(execution.referenceData !== undefined
      ? { referenceData: execution.referenceData }
      : {}),
    ...(execution.references !== undefined
      ? { references: execution.references }
      : {}),
    adapterResult: execution.exactResult,
  });
}

/** Admits whole canonical entries only; content is never summarized or cut. */
function admitExactEvidence(
  candidates: readonly AuditorEvidence[],
): readonly AuditorEvidence[] {
  const selected: AuditorEvidence[] = [];
  let characterCount = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const candidateLength = JSON.stringify(candidate).length;
    if (
      selected.length >= AUDITOR_DECISION_EVIDENCE_LIMIT ||
      characterCount + candidateLength >
        AUDITOR_DECISION_EVIDENCE_TOTAL_MAX_CHARS
    ) {
      continue;
    }
    selected.unshift(candidate);
    characterCount += candidateLength;
  }
  return Object.freeze(selected);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}
