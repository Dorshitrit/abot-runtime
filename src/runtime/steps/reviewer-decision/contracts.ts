import { MODEL_STEPS } from "../../../shared/model-steps.js";
import {
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  ROLE_CALL_REVIEWER_VERDICT_GAP_SUMMARY_MAX_LENGTH,
  ROLE_CALL_REVIEWER_VERDICT_KIND_MAX_LENGTH,
  ROLE_CALL_REVIEWER_VERDICT_MAX_GAPS,
  ROLE_CALL_REVIEWER_VERDICT_MAX_REFS_PER_GAP,
  ROLE_CALL_REVIEWER_VERDICT_REFERENCE_MAX_LENGTH,
  type RoleCapabilityResultReference,
  type RoleCallFrame,
  type RoleCallReviewerVerdictGap,
} from "../../orchestration/role-calls/index.js";

export const REVIEWER_DECISION_MODEL_STEP = MODEL_STEPS.REVIEWER_DECISION;
export const REVIEWER_ROLE_ID = "reviewer" as const;
export const REVIEWER_DECISION_ACTIONS = Object.freeze([
  "pass",
  "report_gaps",
] as const);
export const REVIEWER_MAX_SUBJECTS = 64;
export const REVIEWER_MAX_FACTS = 64;
export const REVIEWER_MAX_EVIDENCE = 64;
export const REVIEWER_MAX_GAPS = ROLE_CALL_REVIEWER_VERDICT_MAX_GAPS;
export const REVIEWER_MAX_GAP_KINDS = 64;
export const REVIEWER_MAX_REFS_PER_GAP =
  ROLE_CALL_REVIEWER_VERDICT_MAX_REFS_PER_GAP;
export const REVIEWER_MAX_SNAPSHOT_LINK_REFS = 64;
export const REVIEWER_REFERENCE_MAX_LENGTH =
  ROLE_CALL_REVIEWER_VERDICT_REFERENCE_MAX_LENGTH;
export const REVIEWER_KIND_MAX_LENGTH =
  ROLE_CALL_REVIEWER_VERDICT_KIND_MAX_LENGTH;
export const REVIEWER_ITEM_SUMMARY_MAX_LENGTH = 2_048;
export const REVIEWER_COMPLETION_TARGET_MAX_LENGTH =
  ROLE_CALL_OBJECTIVE_MAX_LENGTH;
export const REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH =
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH;
export const REVIEWER_DECISION_SUMMARY_MAX_LENGTH = 256;
export const REVIEWER_GAP_SUMMARY_MAX_LENGTH =
  ROLE_CALL_REVIEWER_VERDICT_GAP_SUMMARY_MAX_LENGTH;
export const REVIEWER_DECISION_RESULT_MAX_LENGTH = ROLE_CALL_RESULT_MAX_LENGTH;

export function resolveCanonicalReviewerCompletionTargetText(
  source: string,
): string {
  const normalized = source.trim();
  if (!normalized) throw new Error("reviewer_completion_target_missing");
  return normalized.slice(0, REVIEWER_COMPLETION_TARGET_MAX_LENGTH);
}

export type ReviewerFactStatus =
  | "satisfied"
  | "missing"
  | "mismatched"
  | "contradictory"
  | "indeterminate"
  | "informational";

export type ReviewerEvidenceOutcome = "succeeded" | "failed";
export type ReviewerEvidenceEffect =
  | "none"
  | "observation"
  | "mutation"
  | "indeterminate";
export type ReviewerFreshnessStatus =
  | "not_required"
  | "current"
  | "unavailable";

export type ReviewerSubject = Readonly<{
  subjectRef: string;
  kind: string;
  summary: string;
}>;

export type ReviewerEvidence = Readonly<{
  evidenceRef: string;
  kind: string;
  outcome: ReviewerEvidenceOutcome;
  effect: ReviewerEvidenceEffect;
  subjectRefs: readonly string[];
  summary: string;
  references?: readonly RoleCapabilityResultReference[];
  referenceData?: string;
}>;

export type ReviewerFact = Readonly<{
  factRef: string;
  kind: string;
  status: ReviewerFactStatus;
  subjectRefs: readonly string[];
  evidenceRefs: readonly string[];
  summary: string;
}>;

export type ReviewerReviewSnapshot = Readonly<{
  reviewScopeId: string;
  reviewerCallId: string;
  callerCallId: string;
  sourceRevision: number;
  projectionComplete: boolean;
  freshness: ReviewerFreshnessStatus;
  allowedGapKinds: readonly string[];
  subjects: readonly ReviewerSubject[];
  facts: readonly ReviewerFact[];
  evidence: readonly ReviewerEvidence[];
}>;

export type ReviewerGap = RoleCallReviewerVerdictGap;

export type ReviewerPassDecision = Readonly<{
  action: "pass";
  reviewScopeId: string;
  summary: string;
  gaps: readonly [];
}>;

export type ReviewerReportGapsDecision = Readonly<{
  action: "report_gaps";
  reviewScopeId: string;
  summary: string;
  gaps: readonly ReviewerGap[];
}>;

export type ReviewerDecision =
  | ReviewerPassDecision
  | ReviewerReportGapsDecision;

export type ReviewerDecisionValidationStage = "json_envelope" | "domain_parser";

export type ReviewerDecisionValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type ReviewerDecisionParseResult =
  | Readonly<{ ok: true; decision: ReviewerDecision }>
  | Readonly<{
      ok: false;
      stage: ReviewerDecisionValidationStage;
      issues: readonly ReviewerDecisionValidationIssue[];
    }>;

export type ReviewerDecisionCallIdentity = Readonly<{
  callId: string;
  parentCallId: string;
  depth: number;
  invocationAttempt: number;
}>;

export type ReviewerDecisionDiagnosticContext = Readonly<{
  requestId: string;
  modelStep: typeof REVIEWER_DECISION_MODEL_STEP;
}> &
  ReviewerDecisionCallIdentity;

export function projectReviewerDecisionCallIdentity(
  call: RoleCallFrame,
): ReviewerDecisionCallIdentity {
  if (
    call.roleId !== REVIEWER_ROLE_ID ||
    call.parentCallId === null ||
    call.depth < 1 ||
    call.status !== "active" ||
    call.objective === null ||
    call.objective.trim().length === 0 ||
    call.childCallIds.length !== 0 ||
    call.activationCount !== 1 ||
    call.resultRef !== null
  ) {
    throw new Error("reviewer_call_frame_invalid");
  }
  return Object.freeze({
    callId: call.callId,
    parentCallId: call.parentCallId,
    depth: call.depth,
    invocationAttempt: call.activationCount,
  });
}
