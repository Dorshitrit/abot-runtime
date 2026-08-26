import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { traceDebug } from "../../observability/debug-logger.js";
import {
  REVIEWER_ROLE_ID,
  type ReviewerDecision,
  type ReviewerDecisionDiagnosticContext,
  type ReviewerDecisionValidationIssue,
  type ReviewerReviewSnapshot,
} from "./contracts.js";
import type { ReviewerFinalEvidenceProjection } from "./final-evidence.js";

const REVIEWER_LOG_SCOPE = "runtime.reviewer";
const REVIEWER_LOG_ISSUE_LIMIT = 16;

export function traceReviewerContextProjected(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  objectiveLength: number;
  snapshot: ReviewerReviewSnapshot;
  referenceMessageCount: number;
  configuredInstructionBlockCount: number;
  configuredInstructionCharacterCount: number;
  configuredInstructionRefs: readonly string[];
  configuredInstructionContentHashes: readonly string[];
  auditCapsuleCharacterCount: number;
  evidenceAppendixCharacterCount: number;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "context.projected", {
    ...baseFields(params.diagnostic),
    reviewScopeId: params.snapshot.reviewScopeId,
    sourceRevision: params.snapshot.sourceRevision,
    objectiveLength: params.objectiveLength,
    messageCount: params.context.messages.length,
    messageCharacterCount: params.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    historyMessageCount: 0,
    attachmentCount: 0,
    referenceMessageCount: params.referenceMessageCount,
    modelContextContract: "runtime_reviewer_audit_v2",
    auditCapsuleCharacterCount: params.auditCapsuleCharacterCount,
    evidenceAppendixCharacterCount: params.evidenceAppendixCharacterCount,
    continuationMessageCount: 0,
    projectContextIncluded: false,
    plannedWorkContextIncluded: false,
    capabilityContextIncluded: false,
    projectionComplete: params.snapshot.projectionComplete,
    freshness: params.snapshot.freshness,
    subjectCount: params.snapshot.subjects.length,
    factCount: params.snapshot.facts.length,
    factStatusCounts: countFactStatuses(params.snapshot),
    evidenceCount: params.snapshot.evidence.length,
    allowedGapKindCount: params.snapshot.allowedGapKinds.length,
    allowedGapKinds: params.snapshot.allowedGapKinds,
    subjectSummaryLength: sumLengths(
      params.snapshot.subjects.map(({ summary }) => summary),
    ),
    factSummaryLength: sumLengths(
      params.snapshot.facts.map(({ summary }) => summary),
    ),
    evidenceSummaryLength: sumLengths(
      params.snapshot.evidence.map(({ summary }) => summary),
    ),
    evidenceReferenceDataCount: params.snapshot.evidence.filter(
      ({ referenceData }) => referenceData !== undefined,
    ).length,
    evidenceReferenceDataLength: sumLengths(
      params.snapshot.evidence.flatMap(({ referenceData }) =>
        referenceData ? [referenceData] : [],
      ),
    ),
    schemaCharacterCount: JSON.stringify(params.format.schema).length,
    contextWindowTokens: params.context.budget.contextWindowTokens,
    estimatedInputTokens: params.context.budget.estimatedInputTokens,
    availableInputTokens: params.context.budget.availableInputTokens,
    outputReserveTokens: params.context.budget.outputReserveTokens,
    safetyReserveTokens: params.context.budget.safetyReserveTokens,
    formatReserveTokens: params.context.budget.formatReserveTokens,
    attachmentReserveTokens: params.context.budget.attachmentReserveTokens,
    allowedActions:
      params.snapshot.projectionComplete &&
      params.snapshot.freshness !== "unavailable"
        ? ["pass", "report_gaps"]
        : ["report_gaps"],
    configuredInstructionBlockCount: params.configuredInstructionBlockCount,
    configuredInstructionCharacterCount:
      params.configuredInstructionCharacterCount,
    configuredInstructionRefs: params.configuredInstructionRefs,
    configuredInstructionContentHashes:
      params.configuredInstructionContentHashes,
  });
}

export function traceReviewerContextRejected(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  issues: readonly ReviewerDecisionValidationIssue[];
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "context.rejected", {
    ...baseFields(params.diagnostic),
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
    truncatedIssueCount: Math.max(
      0,
      params.issues.length - REVIEWER_LOG_ISSUE_LIMIT,
    ),
  });
}

export function traceReviewerEnvelopeAccepted(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  outputLength: number;
  keyCount: number;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "output.envelope.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    rootType: "object",
    keyCount: params.keyCount,
  });
}

export function traceReviewerEnvelopeRejected(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  outputLength: number;
  issues: readonly ReviewerDecisionValidationIssue[];
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "output.envelope.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function traceReviewerDecisionAccepted(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  decision: ReviewerDecision;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "decision.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    reviewScopeId: params.decision.reviewScopeId,
    selectedAction: params.decision.action,
    decisionSerializedLength: JSON.stringify(params.decision).length,
    summaryLength: params.decision.summary.length,
    gapCount: params.decision.gaps.length,
    gapKinds: params.decision.gaps.map(({ kind }) => kind),
    gapSubjectRefCount: sumCounts(
      params.decision.gaps.map(({ subjectRefs }) => subjectRefs),
    ),
    gapFactRefCount: sumCounts(
      params.decision.gaps.map(({ factRefs }) => factRefs),
    ),
    gapEvidenceRefCount: sumCounts(
      params.decision.gaps.map(({ evidenceRefs }) => evidenceRefs),
    ),
    gapSummaryLength: sumLengths(
      params.decision.gaps.map(({ summary }) => summary),
    ),
  });
}

export function traceReviewerDecisionTextNormalized(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  path: string;
  inputLength: number;
  outputLength: number;
  maxLength: number;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "decision.text_normalized", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    path: params.path,
    reason: "max_length",
    inputLength: params.inputLength,
    outputLength: params.outputLength,
    maxLength: params.maxLength,
  });
}

export function traceReviewerDecisionRejected(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  issues: readonly ReviewerDecisionValidationIssue[];
  selectedAction?: ReviewerDecision["action"];
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "decision.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    ...(params.selectedAction ? { selectedAction: params.selectedAction } : {}),
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
    truncatedIssueCount: Math.max(
      0,
      params.issues.length - REVIEWER_LOG_ISSUE_LIMIT,
    ),
  });
}

export function traceReviewerModelStarted(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  messageCount: number;
  messageCharacterCount: number;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "model.started", {
    ...baseFields(params.diagnostic),
    messageCount: params.messageCount,
    messageCharacterCount: params.messageCharacterCount,
    allowedActions: ["pass", "report_gaps"],
  });
}

export function traceReviewerModelCompleted(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  decision: ReviewerDecision;
  durationMs: number;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "model.completed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    selectedAction: params.decision.action,
    decisionSerializedLength: JSON.stringify(params.decision).length,
    summaryLength: params.decision.summary.length,
    gapCount: params.decision.gaps.length,
  });
}

export function traceReviewerModelFailed(params: {
  diagnostic: ReviewerDecisionDiagnosticContext;
  durationMs: number;
  errorType: string;
  invalidStructuredOutput: boolean;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "model.failed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    errorType: params.errorType,
    invalidStructuredOutput: params.invalidStructuredOutput,
  });
}

export function traceReviewerExecutionMapped(params: {
  requestId: string;
  call: Readonly<{
    callId: string;
    parentCallId: string | null;
    depth: number;
    activationCount: number;
  }>;
  sourceRevision: number;
  decision: ReviewerDecision;
  serializedLength: number;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "execution.mapped", {
    requestId: params.requestId,
    role: REVIEWER_ROLE_ID,
    callId: params.call.callId,
    parentCallId: params.call.parentCallId,
    depth: params.call.depth,
    invocationAttempt: params.call.activationCount,
    sourceRevision: params.sourceRevision,
    selectedAction: params.decision.action,
    gapCount: params.decision.gaps.length,
    serializedLength: params.serializedLength,
    mappedOutcome: "completed",
  });
}

export function traceReviewerSnapshotProjected(params: {
  requestId: string;
  call: Readonly<{
    callId: string;
    parentCallId: string | null;
    depth: number;
    activationCount: number;
  }>;
  snapshot: ReviewerReviewSnapshot;
  finalEvidence: ReviewerFinalEvidenceProjection;
  callerObjectiveSource: "caller_objective" | "request_source";
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "snapshot.projected", {
    requestId: params.requestId,
    role: REVIEWER_ROLE_ID,
    callId: params.call.callId,
    parentCallId: params.call.parentCallId,
    depth: params.call.depth,
    invocationAttempt: params.call.activationCount,
    reviewScopeId: params.snapshot.reviewScopeId,
    sourceRevision: params.snapshot.sourceRevision,
    projectionComplete: params.snapshot.projectionComplete,
    freshness: params.snapshot.freshness,
    callerObjectiveSource: params.callerObjectiveSource,
    subjectCount: params.snapshot.subjects.length,
    factCount: params.snapshot.facts.length,
    factStatusCounts: countFactStatuses(params.snapshot),
    evidenceCount: params.snapshot.evidence.length,
    sourceCapabilityExecutionCount: params.finalEvidence.sourceExecutionCount,
    supersededCapabilityExecutionCount:
      params.finalEvidence.supersededExecutionCount,
    retainedFailedCapabilityExecutionCount:
      params.finalEvidence.retainedFailedExecutionCount,
    retainedUntargetedCapabilityExecutionCount:
      params.finalEvidence.retainedUntargetedExecutionCount,
    sourceReferenceDataCount: params.finalEvidence.sourceReferenceDataCount,
    sourceReferenceDataChars: params.finalEvidence.sourceReferenceDataChars,
    retainedReferenceDataCount: params.finalEvidence.retainedReferenceDataCount,
    retainedReferenceDataChars: params.finalEvidence.retainedReferenceDataChars,
    omittedReferenceDataCount: params.finalEvidence.omittedReferenceDataCount,
    omittedReferenceDataChars: params.finalEvidence.omittedReferenceDataChars,
    evidenceEffectCounts: countEvidenceEffects(params.snapshot),
  });
}

export function traceReviewerSnapshotRejected(params: {
  requestId: string;
  call: Readonly<{
    callId: string;
    parentCallId: string | null;
    depth: number;
    activationCount: number;
  }>;
  issueCode: string;
}): void {
  traceDebug(REVIEWER_LOG_SCOPE, "snapshot.rejected", {
    requestId: params.requestId,
    role: REVIEWER_ROLE_ID,
    callId: params.call.callId,
    parentCallId: params.call.parentCallId,
    depth: params.call.depth,
    invocationAttempt: params.call.activationCount,
    issueCode: params.issueCode,
  });
}

function baseFields(
  diagnostic: ReviewerDecisionDiagnosticContext,
): Record<string, unknown> {
  return {
    requestId: diagnostic.requestId,
    role: REVIEWER_ROLE_ID,
    modelStep: diagnostic.modelStep,
    callId: diagnostic.callId,
    parentCallId: diagnostic.parentCallId,
    depth: diagnostic.depth,
    invocationAttempt: diagnostic.invocationAttempt,
  };
}

function boundedIssues(
  issues: readonly ReviewerDecisionValidationIssue[],
): readonly Readonly<{ code: string; path: string }>[] {
  return issues
    .slice(0, REVIEWER_LOG_ISSUE_LIMIT)
    .map(({ code, path }) => ({ code, path }));
}

function sumCounts(values: readonly (readonly unknown[])[]): number {
  return values.reduce((total, value) => total + value.length, 0);
}

function sumLengths(values: readonly string[]): number {
  return values.reduce((total, value) => total + value.length, 0);
}

function countFactStatuses(
  snapshot: ReviewerReviewSnapshot,
): Readonly<Record<ReviewerReviewSnapshot["facts"][number]["status"], number>> {
  const counts: Record<
    ReviewerReviewSnapshot["facts"][number]["status"],
    number
  > = {
    satisfied: 0,
    missing: 0,
    mismatched: 0,
    contradictory: 0,
    indeterminate: 0,
    informational: 0,
  };
  for (const { status } of snapshot.facts) {
    counts[status] += 1;
  }
  return Object.freeze(counts);
}

function countEvidenceEffects(
  snapshot: ReviewerReviewSnapshot,
): Readonly<
  Record<ReviewerReviewSnapshot["evidence"][number]["effect"], number>
> {
  const counts: Record<
    ReviewerReviewSnapshot["evidence"][number]["effect"],
    number
  > = {
    none: 0,
    observation: 0,
    mutation: 0,
    indeterminate: 0,
  };
  for (const { effect } of snapshot.evidence) {
    counts[effect] += 1;
  }
  return Object.freeze(counts);
}
