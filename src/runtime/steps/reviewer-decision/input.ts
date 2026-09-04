import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { resolveConfiguredStepInstructionMetadata } from "../../config/runner/step-instructions.js";
import type {
  RequestContextBudget,
  RequestContextProjection,
} from "../../context/request-context-contracts.js";
import {
  assessRequestMessagesBudget,
  projectRequestContext,
  type RequestMessagesBudgetAssessment,
} from "../../context/request-context.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import {
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCapabilityResultReference,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  REVIEWER_DECISION_MODEL_STEP,
  REVIEWER_COMPLETION_TARGET_MAX_LENGTH,
  REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH,
  REVIEWER_ITEM_SUMMARY_MAX_LENGTH,
  REVIEWER_KIND_MAX_LENGTH,
  REVIEWER_MAX_EVIDENCE,
  REVIEWER_MAX_FACTS,
  REVIEWER_MAX_GAP_KINDS,
  REVIEWER_MAX_SNAPSHOT_LINK_REFS,
  REVIEWER_MAX_SUBJECTS,
  REVIEWER_REFERENCE_MAX_LENGTH,
  projectReviewerDecisionCallIdentity,
  type ReviewerDecisionDiagnosticContext,
  type ReviewerDecisionValidationIssue,
  type ReviewerEvidence,
  type ReviewerFact,
  type ReviewerReviewSnapshot,
  type ReviewerSubject,
} from "./contracts.js";
import {
  traceReviewerContextProjected,
  traceReviewerContextRejected,
} from "./diagnostics.js";
import {
  estimateReferenceDataTokens,
  type ReviewerReferenceDataBudget,
} from "./final-evidence.js";
import { createReviewerDecisionFormat } from "./format.js";
import { projectReviewerModelContext } from "./model-context.js";
import { buildReviewerDecisionInstructions } from "./prompt.js";

export type ReviewerDecisionInputRequest = Pick<
  RequestExecutionSeed,
  | "requestId"
  | "prompt"
  | "runnerConfig"
  | "agentMode"
  | "modelPreference"
  | "modelPolicy"
> &
  Partial<Pick<RequestExecutionSeed, "onEvent">>;

export class ReviewerReviewSnapshotValidationError extends Error {
  readonly issues: readonly ReviewerDecisionValidationIssue[];

  constructor(issues: readonly ReviewerDecisionValidationIssue[]) {
    super("reviewer_snapshot_invalid");
    this.name = "ReviewerReviewSnapshotValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export function buildReviewerDecisionInput(
  request: ReviewerDecisionInputRequest,
  options: Readonly<{
    call: RoleCallFrame;
    snapshot: ReviewerReviewSnapshot;
    diagnostic?: ReviewerDecisionDiagnosticContext;
    budget?: RequestContextBudget;
    referenceDataBudget: ReviewerReferenceDataBudget;
  }>,
): {
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  modelStep: typeof REVIEWER_DECISION_MODEL_STEP;
  diagnostic: ReviewerDecisionDiagnosticContext;
  snapshot: ReviewerReviewSnapshot;
} {
  const callIdentity = projectReviewerDecisionCallIdentity(options.call);
  const diagnostic =
    options.diagnostic ??
    ({
      requestId: request.requestId,
      modelStep: REVIEWER_DECISION_MODEL_STEP,
      ...callIdentity,
    } satisfies ReviewerDecisionDiagnosticContext);
  const budget =
    options.budget ?? resolveReviewerDecisionContextBudget(request);
  let snapshot: ReviewerReviewSnapshot;
  try {
    snapshot = normalizeReviewerReviewSnapshot(
      options.snapshot,
      options.call,
      options.referenceDataBudget,
    );
  } catch (error: unknown) {
    if (error instanceof ReviewerReviewSnapshotValidationError) {
      traceReviewerContextRejected({ diagnostic, issues: error.issues });
    }
    throw error;
  }
  const parts = createReviewerDecisionInputParts(request, {
    call: options.call,
    snapshot,
  });
  const context = projectRequestContext({
    instructions: parts.instructions,
    format: parts.format,
    historyMessages: [],
    prompt: parts.prompt,
    referenceMessages: parts.referenceMessages,
    budget,
    diagnostic,
    ...(request.onEvent ? { onEvent: request.onEvent } : {}),
    deferCompactionFailure: true,
  });
  traceReviewerContextProjected({
    diagnostic,
    context,
    format: parts.format,
    objectiveLength: parts.completionTargetLength,
    snapshot,
    referenceMessageCount: parts.referenceMessages.length,
    configuredInstructionBlockCount:
      parts.configuredInstructionMetadata.blockCount,
    configuredInstructionCharacterCount:
      parts.configuredInstructionMetadata.characterCount,
    configuredInstructionRefs: parts.configuredInstructionMetadata.refs,
    configuredInstructionContentHashes:
      parts.configuredInstructionMetadata.contentHashes,
    auditCapsuleCharacterCount: parts.auditCapsuleCharacterCount,
    evidenceAppendixCharacterCount: parts.evidenceAppendixCharacterCount,
  });
  return {
    context,
    format: parts.format,
    modelStep: REVIEWER_DECISION_MODEL_STEP,
    diagnostic,
    snapshot,
  };
}

export function resolveReviewerDecisionContextBudget(
  request: ReviewerDecisionInputRequest,
): RequestContextBudget {
  return resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: REVIEWER_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
}

export function assessReviewerDecisionInputBudget(
  request: ReviewerDecisionInputRequest,
  options: Readonly<{
    call: RoleCallFrame;
    snapshot: ReviewerReviewSnapshot;
    budget: RequestContextBudget;
  }>,
): RequestMessagesBudgetAssessment {
  const parts = createReviewerDecisionInputParts(request, options);
  return assessRequestMessagesBudget({
    messages: [
      { role: "system", content: parts.instructions },
      ...parts.referenceMessages,
      { role: "user", content: parts.prompt },
    ],
    format: parts.format,
    budget: options.budget,
  });
}

function createReviewerDecisionInputParts(
  request: ReviewerDecisionInputRequest,
  options: Readonly<{
    call: RoleCallFrame;
    snapshot: ReviewerReviewSnapshot;
  }>,
) {
  const format = createReviewerDecisionFormat(options.snapshot);
  const modelContext = projectReviewerModelContext(options.snapshot, options.call);
  const configuredInstructionMetadata =
    resolveConfiguredStepInstructionMetadata({
      runnerConfig: request.runnerConfig,
      modelStep: REVIEWER_DECISION_MODEL_STEP,
    });
  return {
    instructions: buildReviewerDecisionInstructions(),
    configuredInstructionMetadata,
    format,
    referenceMessages: modelContext.referenceMessages,
    prompt: modelContext.prompt,
    completionTargetLength: modelContext.completionTargetLength,
    auditCapsuleCharacterCount: modelContext.auditCapsuleCharacterCount,
    evidenceAppendixCharacterCount: modelContext.evidenceAppendixCharacterCount,
  };
}

export function normalizeReviewerReviewSnapshot(
  input: unknown,
  call: RoleCallFrame,
  referenceDataBudget?: ReviewerReferenceDataBudget,
): ReviewerReviewSnapshot {
  const issues: ReviewerDecisionValidationIssue[] = [];
  const record = asRecord(input);
  if (!record) {
    throw new ReviewerReviewSnapshotValidationError([
      issue("reviewer_snapshot_not_object", "snapshot"),
    ]);
  }
  exactKeys(
    record,
    [
      "reviewScopeId",
      "reviewerCallId",
      "callerCallId",
      "sourceRevision",
      "projectionComplete",
      "freshness",
      "allowedGapKinds",
      "subjects",
      "facts",
      "evidence",
    ],
    "snapshot",
    issues,
  );
  const reviewScopeId = parseReference(
    record.reviewScopeId,
    "snapshot.reviewScopeId",
    issues,
  );
  const reviewerCallId = parseReference(
    record.reviewerCallId,
    "snapshot.reviewerCallId",
    issues,
  );
  const callerCallId = parseReference(
    record.callerCallId,
    "snapshot.callerCallId",
    issues,
  );
  if (reviewerCallId !== call.callId) {
    issues.push(
      issue("reviewer_snapshot_call_mismatch", "snapshot.reviewerCallId"),
    );
  }
  if (callerCallId !== call.parentCallId) {
    issues.push(
      issue("reviewer_snapshot_caller_mismatch", "snapshot.callerCallId"),
    );
  }
  const sourceRevision =
    typeof record.sourceRevision === "number" &&
    Number.isSafeInteger(record.sourceRevision) &&
    record.sourceRevision >= 0
      ? record.sourceRevision
      : undefined;
  if (sourceRevision === undefined) {
    issues.push(
      issue("reviewer_snapshot_revision_invalid", "snapshot.sourceRevision"),
    );
  }
  const projectionComplete =
    typeof record.projectionComplete === "boolean"
      ? record.projectionComplete
      : undefined;
  if (projectionComplete === undefined) {
    issues.push(
      issue(
        "reviewer_snapshot_projection_invalid",
        "snapshot.projectionComplete",
      ),
    );
  }
  const freshness =
    record.freshness === "not_required" ||
    record.freshness === "current" ||
    record.freshness === "unavailable"
      ? record.freshness
      : undefined;
  if (!freshness) {
    issues.push(
      issue("reviewer_snapshot_freshness_invalid", "snapshot.freshness"),
    );
  }
  const allowedGapKinds = parseUniqueKinds(
    record.allowedGapKinds,
    "snapshot.allowedGapKinds",
    issues,
    true,
  );
  const subjects = parseSubjects(record.subjects, issues);
  if (subjects.filter(({ kind }) => kind === "caller_objective").length !== 1) {
    issues.push(
      issue("reviewer_snapshot_completion_target_invalid", "snapshot.subjects"),
    );
  }
  const subjectRefs = new Set(subjects.map(({ subjectRef }) => subjectRef));
  const evidence = parseEvidence(record.evidence, subjectRefs, issues);
  if (
    referenceDataBudget &&
    evidence.reduce(
      (total, { referenceData }) =>
        total +
        (referenceData
          ? estimateReferenceDataTokens(
              referenceData,
              referenceDataBudget.tokenEstimation,
            )
          : 0),
      0,
    ) > referenceDataBudget.maxTokens
  ) {
    issues.push(
      issue(
        "reviewer_snapshot_reference_data_total_invalid",
        "snapshot.evidence",
      ),
    );
  }
  const evidenceRefs = new Set(evidence.map(({ evidenceRef }) => evidenceRef));
  const facts = parseFacts(record.facts, subjectRefs, evidenceRefs, issues);

  if (
    issues.length > 0 ||
    !reviewScopeId ||
    !reviewerCallId ||
    !callerCallId ||
    sourceRevision === undefined ||
    projectionComplete === undefined ||
    !freshness
  ) {
    throw new ReviewerReviewSnapshotValidationError(issues);
  }

  return deepFreeze({
    reviewScopeId,
    reviewerCallId,
    callerCallId,
    sourceRevision,
    projectionComplete,
    freshness,
    allowedGapKinds,
    subjects,
    facts,
    evidence,
  });
}

function parseSubjects(
  value: unknown,
  issues: ReviewerDecisionValidationIssue[],
): ReviewerSubject[] {
  const records = parseBoundedRecordArray(
    value,
    REVIEWER_MAX_SUBJECTS,
    "snapshot.subjects",
    issues,
  );
  const subjects: ReviewerSubject[] = [];
  for (const { index, record } of records) {
    const path = `snapshot.subjects[${index}]`;
    exactKeys(record, ["subjectRef", "kind", "summary"], path, issues);
    const subjectRef = parseReference(
      record.subjectRef,
      `${path}.subjectRef`,
      issues,
    );
    const kind = parseKind(record.kind, `${path}.kind`, issues);
    const summary = parseSummary(
      record.summary,
      `${path}.summary`,
      issues,
      kind === "caller_objective"
        ? REVIEWER_COMPLETION_TARGET_MAX_LENGTH
        : REVIEWER_ITEM_SUMMARY_MAX_LENGTH,
    );
    if (subjectRef && kind && summary) {
      subjects.push({ subjectRef, kind, summary });
    }
  }
  rejectDuplicateRefs(
    subjects.map(({ subjectRef }) => subjectRef),
    "reviewer_snapshot_subject_duplicate",
    "snapshot.subjects",
    issues,
  );
  return subjects;
}

function parseEvidence(
  value: unknown,
  subjectRefs: ReadonlySet<string>,
  issues: ReviewerDecisionValidationIssue[],
): ReviewerEvidence[] {
  const records = parseBoundedRecordArray(
    value,
    REVIEWER_MAX_EVIDENCE,
    "snapshot.evidence",
    issues,
  );
  const evidence: ReviewerEvidence[] = [];
  for (const { index, record } of records) {
    const path = `snapshot.evidence[${index}]`;
    exactKeys(
      record,
      [
        "evidenceRef",
        "kind",
        "outcome",
        "effect",
        "subjectRefs",
        "summary",
        ...(record.references === undefined ? [] : ["references"]),
        ...(record.referenceData === undefined ? [] : ["referenceData"]),
      ],
      path,
      issues,
    );
    const evidenceRef = parseReference(
      record.evidenceRef,
      `${path}.evidenceRef`,
      issues,
    );
    const kind = parseKind(record.kind, `${path}.kind`, issues);
    const outcome =
      record.outcome === "succeeded" || record.outcome === "failed"
        ? record.outcome
        : undefined;
    if (!outcome) {
      issues.push(
        issue("reviewer_snapshot_evidence_outcome_invalid", `${path}.outcome`),
      );
    }
    const effect =
      record.effect === "none" ||
      record.effect === "observation" ||
      record.effect === "mutation" ||
      record.effect === "indeterminate"
        ? record.effect
        : undefined;
    if (!effect) {
      issues.push(
        issue("reviewer_snapshot_evidence_effect_invalid", `${path}.effect`),
      );
    }
    const linkedSubjects = parseKnownReferenceArray(
      record.subjectRefs,
      subjectRefs,
      `${path}.subjectRefs`,
      issues,
    );
    const summary = parseSummary(record.summary, `${path}.summary`, issues);
    const references = parseEvidenceReferences(
      record.references,
      `${path}.references`,
      issues,
    );
    const referenceData = parseOptionalReferenceData(
      record.referenceData,
      `${path}.referenceData`,
      issues,
    );
    if (evidenceRef && kind && outcome && effect && summary) {
      evidence.push({
        evidenceRef,
        kind,
        outcome,
        effect,
        subjectRefs: linkedSubjects,
        summary,
        ...(references ? { references } : {}),
        ...(referenceData ? { referenceData } : {}),
      });
    }
  }
  rejectDuplicateRefs(
    evidence.map(({ evidenceRef }) => evidenceRef),
    "reviewer_snapshot_evidence_duplicate",
    "snapshot.evidence",
    issues,
  );
  return evidence;
}

function parseEvidenceReferences(
  value: unknown,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): readonly RoleCapabilityResultReference[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX
  ) {
    issues.push(issue("reviewer_snapshot_evidence_references_invalid", path));
    return undefined;
  }
  const references = value.flatMap((entry, index) => {
    const record = asRecord(entry);
    const target = record?.target;
    if (
      !record ||
      Object.keys(record).length !== 2 ||
      record.kind !== "tool_target" ||
      typeof target !== "string" ||
      target.trim().length === 0 ||
      target !== target.trim() ||
      target.length > ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH
    ) {
      issues.push(
        issue(
          "reviewer_snapshot_evidence_reference_invalid",
          `${path}[${index}]`,
        ),
      );
      return [];
    }
    return [{ kind: "tool_target" as const, target }];
  });
  if (
    new Set(references.map(({ target }) => target)).size !== references.length
  ) {
    issues.push(issue("reviewer_snapshot_evidence_reference_duplicate", path));
  }
  return Object.freeze(references);
}

function parseOptionalReferenceData(
  value: unknown,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH
  ) {
    issues.push(issue("reviewer_snapshot_reference_data_invalid", path));
    return undefined;
  }
  return value;
}

function parseFacts(
  value: unknown,
  subjectRefs: ReadonlySet<string>,
  evidenceRefs: ReadonlySet<string>,
  issues: ReviewerDecisionValidationIssue[],
): ReviewerFact[] {
  const records = parseBoundedRecordArray(
    value,
    REVIEWER_MAX_FACTS,
    "snapshot.facts",
    issues,
  );
  const facts: ReviewerFact[] = [];
  for (const { index, record } of records) {
    const path = `snapshot.facts[${index}]`;
    exactKeys(
      record,
      ["factRef", "kind", "status", "subjectRefs", "evidenceRefs", "summary"],
      path,
      issues,
    );
    const factRef = parseReference(record.factRef, `${path}.factRef`, issues);
    const kind = parseKind(record.kind, `${path}.kind`, issues);
    const status =
      record.status === "satisfied" ||
      record.status === "missing" ||
      record.status === "mismatched" ||
      record.status === "contradictory" ||
      record.status === "indeterminate" ||
      record.status === "informational"
        ? record.status
        : undefined;
    if (!status) {
      issues.push(
        issue("reviewer_snapshot_fact_status_invalid", `${path}.status`),
      );
    }
    const linkedSubjects = parseKnownReferenceArray(
      record.subjectRefs,
      subjectRefs,
      `${path}.subjectRefs`,
      issues,
    );
    const linkedEvidence = parseKnownReferenceArray(
      record.evidenceRefs,
      evidenceRefs,
      `${path}.evidenceRefs`,
      issues,
    );
    const summary = parseSummary(record.summary, `${path}.summary`, issues);
    if (factRef && kind && status && summary) {
      facts.push({
        factRef,
        kind,
        status,
        subjectRefs: linkedSubjects,
        evidenceRefs: linkedEvidence,
        summary,
      });
    }
  }
  rejectDuplicateRefs(
    facts.map(({ factRef }) => factRef),
    "reviewer_snapshot_fact_duplicate",
    "snapshot.facts",
    issues,
  );
  return facts;
}

function parseBoundedRecordArray(
  value: unknown,
  limit: number,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): Array<Readonly<{ index: number; record: Record<string, unknown> }>> {
  if (!Array.isArray(value) || value.length > limit) {
    issues.push(issue("reviewer_snapshot_array_invalid", path));
    return [];
  }
  const records: Array<
    Readonly<{ index: number; record: Record<string, unknown> }>
  > = [];
  value.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      issues.push(issue("reviewer_snapshot_item_invalid", `${path}[${index}]`));
    } else {
      records.push({ index, record });
    }
  });
  return records;
}

function parseUniqueKinds(
  value: unknown,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
  requireNonEmpty: boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > REVIEWER_MAX_GAP_KINDS ||
    (requireNonEmpty && value.length === 0)
  ) {
    issues.push(issue("reviewer_snapshot_gap_kinds_invalid", path));
    return [];
  }
  const kinds = value.flatMap((entry, index) => {
    const kind = parseKind(entry, `${path}[${index}]`, issues);
    return kind ? [kind] : [];
  });
  rejectDuplicateRefs(
    kinds,
    "reviewer_snapshot_gap_kind_duplicate",
    path,
    issues,
  );
  return kinds;
}

function parseKnownReferenceArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): string[] {
  if (!Array.isArray(value) || value.length > REVIEWER_MAX_SNAPSHOT_LINK_REFS) {
    issues.push(issue("reviewer_snapshot_reference_array_invalid", path));
    return [];
  }
  const refs = value.flatMap((entry, index) => {
    const ref = parseReference(entry, `${path}[${index}]`, issues);
    if (ref && !allowed.has(ref)) {
      issues.push(
        issue("reviewer_snapshot_reference_unknown", `${path}[${index}]`),
      );
      return [];
    }
    return ref ? [ref] : [];
  });
  rejectDuplicateRefs(
    refs,
    "reviewer_snapshot_reference_duplicate",
    path,
    issues,
  );
  return refs;
}

function parseReference(
  value: unknown,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > REVIEWER_REFERENCE_MAX_LENGTH ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/%-]*$/.test(value)
  ) {
    issues.push(issue("reviewer_snapshot_reference_invalid", path));
    return undefined;
  }
  return value;
}

function parseKind(
  value: unknown,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > REVIEWER_KIND_MAX_LENGTH ||
    value !== value.trim() ||
    !/^[a-z][a-z0-9._-]*$/.test(value)
  ) {
    issues.push(issue("reviewer_snapshot_kind_invalid", path));
    return undefined;
  }
  return value;
}

function parseSummary(
  value: unknown,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
  maxLength = REVIEWER_ITEM_SUMMARY_MAX_LENGTH,
): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string" ||
    normalized.length === 0 ||
    value.length > maxLength
  ) {
    issues.push(issue("reviewer_snapshot_summary_invalid", path));
    return undefined;
  }
  return normalized;
}

function rejectDuplicateRefs(
  values: readonly string[],
  code: string,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): void {
  if (new Set(values).size !== values.length) {
    issues.push(issue(code, path));
  }
}

function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): void {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    issues.push(issue("reviewer_snapshot_shape_invalid", path));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function issue(code: string, path: string): ReviewerDecisionValidationIssue {
  return {
    code,
    path,
    message: `Reviewer snapshot failed ${code}.`,
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
