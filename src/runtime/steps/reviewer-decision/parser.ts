import {
  REVIEWER_DECISION_ACTIONS,
  REVIEWER_DECISION_RESULT_MAX_LENGTH,
  REVIEWER_DECISION_SUMMARY_MAX_LENGTH,
  REVIEWER_GAP_SUMMARY_MAX_LENGTH,
  REVIEWER_MAX_GAPS,
  REVIEWER_MAX_REFS_PER_GAP,
  type ReviewerDecision,
  type ReviewerDecisionDiagnosticContext,
  type ReviewerDecisionParseResult,
  type ReviewerDecisionValidationIssue,
  type ReviewerGap,
  type ReviewerReviewSnapshot,
} from "./contracts.js";
import {
  traceReviewerDecisionAccepted,
  traceReviewerDecisionRejected,
  traceReviewerDecisionTextNormalized,
  traceReviewerEnvelopeAccepted,
  traceReviewerEnvelopeRejected,
} from "./diagnostics.js";
import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";

export function parseReviewerDecisionOutput(
  text: string,
  options: Readonly<{
    snapshot: ReviewerReviewSnapshot;
    diagnostic?: ReviewerDecisionDiagnosticContext;
  }>,
): ReviewerDecisionParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejectEnvelope(
      text.length,
      [issue("reviewer_output_not_json", "decision")],
      options.diagnostic,
    );
  }
  if (!asRecord(decoded)) {
    return rejectEnvelope(
      text.length,
      [issue("reviewer_output_not_object", "decision")],
      options.diagnostic,
    );
  }
  const record = readStructuredDecisionEnvelope(decoded);
  if (!record) {
    return rejectEnvelope(
      text.length,
      [issue("reviewer_output_envelope_invalid", "decision")],
      options.diagnostic,
    );
  }
  if (options.diagnostic) {
    traceReviewerEnvelopeAccepted({
      diagnostic: options.diagnostic,
      outputLength: text.length,
      keyCount: Object.keys(record).length,
    });
  }

  const issues: ReviewerDecisionValidationIssue[] = [];
  const textNormalizations: ReviewerTextNormalization[] = [];
  exactKeys(
    record,
    ["action", "reviewScopeId", "summary", "gaps"],
    "decision",
    issues,
  );
  const action =
    record.action === "pass" || record.action === "report_gaps"
      ? record.action
      : undefined;
  if (!action) {
    issues.push(issue("reviewer_action_invalid", "decision.action"));
  }
  if (record.reviewScopeId !== options.snapshot.reviewScopeId) {
    issues.push(issue("reviewer_scope_mismatch", "decision.reviewScopeId"));
  }
  const summary = parseBoundedText(
    record.summary,
    REVIEWER_DECISION_SUMMARY_MAX_LENGTH,
    "reviewer_summary_invalid",
    "decision.summary",
    issues,
    textNormalizations,
  );
  const parsedGaps = parseGaps(
    record.gaps,
    options.snapshot,
    issues,
    textNormalizations,
  );
  if (
    action === "pass" &&
    parsedGaps.cardinalityValid &&
    parsedGaps.inputCount > 0
  ) {
    issues.push(issue("reviewer_pass_gaps_invalid", "decision.gaps"));
  }
  if (
    action === "pass" &&
    (!options.snapshot.projectionComplete ||
      options.snapshot.freshness === "unavailable")
  ) {
    issues.push(issue("reviewer_pass_evidence_incomplete", "decision.action"));
  }
  if (
    action === "report_gaps" &&
    parsedGaps.cardinalityValid &&
    parsedGaps.inputCount === 0
  ) {
    issues.push(issue("reviewer_gaps_required", "decision.gaps"));
  }

  if (issues.length > 0 || !action || !summary) {
    if (options.diagnostic) {
      traceReviewerDecisionRejected({
        diagnostic: options.diagnostic,
        issues,
        ...(action ? { selectedAction: action } : {}),
      });
    }
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    };
  }

  const decision: ReviewerDecision =
    action === "pass"
      ? {
          action,
          reviewScopeId: options.snapshot.reviewScopeId,
          summary,
          gaps: [],
        }
      : {
          action,
          reviewScopeId: options.snapshot.reviewScopeId,
          summary,
          gaps: parsedGaps.gaps,
        };
  if (JSON.stringify(decision).length > REVIEWER_DECISION_RESULT_MAX_LENGTH) {
    const resultIssues = [
      issue("reviewer_decision_result_too_large", "decision"),
    ];
    if (options.diagnostic) {
      traceReviewerDecisionRejected({
        diagnostic: options.diagnostic,
        issues: resultIssues,
        selectedAction: action,
      });
    }
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(resultIssues),
    };
  }
  const accepted = deepFreeze(structuredClone(decision));
  if (options.diagnostic) {
    for (const normalization of textNormalizations) {
      traceReviewerDecisionTextNormalized({
        diagnostic: options.diagnostic,
        ...normalization,
      });
    }
    traceReviewerDecisionAccepted({
      diagnostic: options.diagnostic,
      decision: accepted,
    });
  }
  return { ok: true, decision: accepted };
}

function parseGaps(
  value: unknown,
  snapshot: ReviewerReviewSnapshot,
  issues: ReviewerDecisionValidationIssue[],
  textNormalizations: ReviewerTextNormalization[],
): Readonly<{
  gaps: ReviewerGap[];
  inputCount: number;
  cardinalityValid: boolean;
}> {
  if (!Array.isArray(value) || value.length > REVIEWER_MAX_GAPS) {
    issues.push(issue("reviewer_gaps_invalid", "decision.gaps"));
    return {
      gaps: [],
      inputCount: Array.isArray(value) ? value.length : 0,
      cardinalityValid: false,
    };
  }
  const gaps: ReviewerGap[] = [];
  const allowedSubjectRefs = new Set(
    snapshot.subjects.map(({ subjectRef }) => subjectRef),
  );
  const allowedFactRefs = new Set(snapshot.facts.map(({ factRef }) => factRef));
  const allowedEvidenceRefs = new Set(
    snapshot.evidence.map(({ evidenceRef }) => evidenceRef),
  );
  value.forEach((entry, index) => {
    const path = `decision.gaps[${index}]`;
    const record = asRecord(entry);
    if (!record) {
      issues.push(issue("reviewer_gap_invalid", path));
      return;
    }
    exactKeys(
      record,
      ["kind", "subjectRefs", "factRefs", "evidenceRefs", "summary"],
      path,
      issues,
    );
    const kind =
      typeof record.kind === "string" &&
      snapshot.allowedGapKinds.includes(record.kind)
        ? record.kind
        : undefined;
    if (!kind) {
      issues.push(issue("reviewer_gap_kind_invalid", `${path}.kind`));
    }
    const subjectRefs = parseReferenceArray(
      record.subjectRefs,
      allowedSubjectRefs,
      `${path}.subjectRefs`,
      issues,
    );
    const factRefs = parseReferenceArray(
      record.factRefs,
      allowedFactRefs,
      `${path}.factRefs`,
      issues,
    );
    const evidenceRefs = parseReferenceArray(
      record.evidenceRefs,
      allowedEvidenceRefs,
      `${path}.evidenceRefs`,
      issues,
    );
    const summary = parseBoundedText(
      record.summary,
      REVIEWER_GAP_SUMMARY_MAX_LENGTH,
      "reviewer_gap_summary_invalid",
      `${path}.summary`,
      issues,
      textNormalizations,
    );
    if (kind && summary) {
      gaps.push({
        kind,
        subjectRefs,
        factRefs,
        evidenceRefs,
        summary,
      });
    }
  });
  return {
    gaps,
    inputCount: value.length,
    cardinalityValid: true,
  };
}

function parseReferenceArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): string[] {
  if (!Array.isArray(value) || value.length > REVIEWER_MAX_REFS_PER_GAP) {
    issues.push(issue("reviewer_gap_refs_invalid", path));
    return [];
  }
  const refs: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      issues.push(issue("reviewer_gap_ref_unknown", `${path}[${index}]`));
      return;
    }
    if (refs.includes(entry)) {
      issues.push(issue("reviewer_gap_ref_duplicate", `${path}[${index}]`));
      return;
    }
    refs.push(entry);
  });
  return refs;
}

function parseBoundedText(
  value: unknown,
  maxLength: number,
  code: string,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
  textNormalizations: ReviewerTextNormalization[],
): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string" ||
    normalized.length === 0 ||
    /[\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(value)
  ) {
    issues.push(issue(code, path));
    return undefined;
  }
  if (normalized.length > maxLength) {
    const bounded = `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
    textNormalizations.push({
      path,
      inputLength: normalized.length,
      outputLength: bounded.length,
      maxLength,
    });
    return bounded;
  }
  return normalized;
}

type ReviewerTextNormalization = Readonly<{
  path: string;
  inputLength: number;
  outputLength: number;
  maxLength: number;
}>;

function rejectEnvelope(
  outputLength: number,
  issues: readonly ReviewerDecisionValidationIssue[],
  diagnostic?: ReviewerDecisionDiagnosticContext,
): ReviewerDecisionParseResult {
  if (diagnostic) {
    traceReviewerEnvelopeRejected({ diagnostic, outputLength, issues });
  }
  return {
    ok: false,
    stage: "json_envelope",
    issues: Object.freeze([...issues]),
  };
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
    issues.push(issue("reviewer_decision_shape_invalid", path));
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
    message:
      code === "reviewer_action_invalid"
        ? `Action must be one of: ${REVIEWER_DECISION_ACTIONS.join(", ")}.`
        : `Reviewer decision failed ${code}.`,
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
