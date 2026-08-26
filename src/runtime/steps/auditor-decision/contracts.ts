import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { CapabilityAdapterResult } from "../../orchestration/capability-adapters/index.js";

export const AUDITOR_DECISION_MODEL_STEP = MODEL_STEPS.AUDITOR_DECISION;
export const EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID =
  "request_completion" as const;
export const EXECUTION_AGENT_AUDIT_OBJECTIVE_KIND =
  "runtime_execution_agent_audit_objective_v1" as const;
export const AUDITOR_DECISION_IDENTIFIER_MAX_LENGTH = 128;
export const AUDITOR_DECISION_TEXT_MAX_LENGTH = 8_192;
export const AUDITOR_DECISION_CRITERION_LIMIT = 32;
export const AUDITOR_DECISION_EVIDENCE_LIMIT = 16;
export const AUDITOR_DECISION_EVIDENCE_TOTAL_MAX_CHARS = 48_000;

export type ExecutionAgentAuditObjective = Readonly<{
  kind: typeof EXECUTION_AGENT_AUDIT_OBJECTIVE_KIND;
  criterionIds: readonly string[];
  requestSteeringVersion: number;
}>;

export type AuditorCriterion = Readonly<{
  criterionId: string;
  description: string;
}>;

export type AuditorCapabilityEvidence = Readonly<{
  kind: "capability_result";
  executionId: string;
  capabilityId: string;
  declaredEffect: "observation" | "mutation" | "mixed";
  outcome: "succeeded" | "failed";
  observedEffect: "none" | "observation" | "mutation" | "indeterminate";
  summary: string;
  referenceData?: string;
  references?: readonly Readonly<{ kind: "tool_target"; target: string }>[];
  adapterResult: CapabilityAdapterResult;
}>;

export type AuditorRoleResultEvidence = Readonly<{
  kind: "subordinate_result";
  resultRef: string;
  producerCallId: string;
  roleId: "planner" | "worker" | "researcher" | "reviewer";
  outcome: "completed" | "failed";
  summary: string;
}>;

export type AuditorEvidence =
  | AuditorCapabilityEvidence
  | AuditorRoleResultEvidence;

export type AuditorAssignment = Readonly<{
  auditId: string;
  callerCallId: string;
  target: string;
  sourceRevision: number;
  criterionIds: readonly string[];
  criteria: readonly AuditorCriterion[];
  evidence: readonly AuditorEvidence[];
  availableEvidenceCount: number;
  omittedEvidenceCount: number;
}>;

export type AuditorEvidenceProjectionStatus = Readonly<{
  complete: boolean;
  evidenceCountConsistent: boolean;
  projectedEvidenceCount: number;
  availableEvidenceCount: number;
  omittedEvidenceCount: number;
}>;

export type AuditorGap = Readonly<{
  criterionId: string;
  description: string;
}>;

export type AuditorDecision =
  | Readonly<{
      auditId: string;
      verdict: "pass";
      criterionIds: readonly string[];
      gaps: readonly [];
    }>
  | Readonly<{
      auditId: string;
      verdict: "gaps";
      criterionIds: readonly string[];
      gaps: readonly AuditorGap[];
    }>;

export type AuditorDecisionValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type AuditorDecisionParseResult =
  | Readonly<{ ok: true; decision: AuditorDecision }>
  | Readonly<{
      ok: false;
      stage: "json_envelope" | "domain_parser";
      issues: readonly AuditorDecisionValidationIssue[];
    }>;

export function encodeExecutionAgentAuditObjective(
  criterionIds: readonly string[],
  requestSteeringVersion = 0,
): string {
  if (
    !Number.isSafeInteger(requestSteeringVersion) ||
    requestSteeringVersion < 0
  ) {
    throw new Error("execution_agent_audit_steering_version_invalid");
  }
  return JSON.stringify({
    kind: EXECUTION_AGENT_AUDIT_OBJECTIVE_KIND,
    criterionIds: sealCriterionIds(criterionIds),
    requestSteeringVersion,
  });
}

export function parseExecutionAgentAuditObjective(
  input: string,
): ExecutionAgentAuditObjective {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input) as unknown;
  } catch {
    throw new Error("execution_agent_audit_objective_invalid");
  }
  if (
    !isRecord(decoded) ||
    Object.keys(decoded).length !== 3 ||
    decoded.kind !== EXECUTION_AGENT_AUDIT_OBJECTIVE_KIND ||
    !Object.hasOwn(decoded, "criterionIds") ||
    !Number.isSafeInteger(decoded.requestSteeringVersion) ||
    (decoded.requestSteeringVersion as number) < 0
  ) {
    throw new Error("execution_agent_audit_objective_invalid");
  }
  return Object.freeze({
    kind: EXECUTION_AGENT_AUDIT_OBJECTIVE_KIND,
    criterionIds: sealCriterionIds(decoded.criterionIds),
    requestSteeringVersion: decoded.requestSteeringVersion as number,
  });
}

export function projectAuditorEvidenceProjectionStatus(
  assignment: AuditorAssignment,
): AuditorEvidenceProjectionStatus {
  const evidenceCountConsistent =
    Number.isSafeInteger(assignment.availableEvidenceCount) &&
    Number.isSafeInteger(assignment.omittedEvidenceCount) &&
    assignment.availableEvidenceCount >= 0 &&
    assignment.omittedEvidenceCount >= 0 &&
    assignment.availableEvidenceCount ===
      assignment.evidence.length + assignment.omittedEvidenceCount;
  return Object.freeze({
    complete:
      evidenceCountConsistent &&
      assignment.evidence.length > 0 &&
      assignment.omittedEvidenceCount === 0,
    evidenceCountConsistent,
    projectedEvidenceCount: assignment.evidence.length,
    availableEvidenceCount: assignment.availableEvidenceCount,
    omittedEvidenceCount: assignment.omittedEvidenceCount,
  });
}

function sealCriterionIds(input: unknown): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > AUDITOR_DECISION_CRITERION_LIMIT ||
    !input.every(
      (criterionId) =>
        typeof criterionId === "string" &&
        criterionId.length > 0 &&
        criterionId.length <= AUDITOR_DECISION_IDENTIFIER_MAX_LENGTH &&
        /^[a-zA-Z][a-zA-Z0-9._-]*$/u.test(criterionId),
    ) ||
    new Set(input).size !== input.length
  ) {
    throw new Error("execution_agent_audit_criterion_ids_invalid");
  }
  const criterionIds = Object.freeze([...input] as string[]);
  if (
    criterionIds.some(
      (criterionId) => criterionId !== EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID,
    )
  ) {
    throw new Error("execution_agent_audit_criterion_unknown");
  }
  return criterionIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
