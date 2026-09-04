import {
  REVIEWER_MAX_EVIDENCE,
  type ReviewerDecisionValidationIssue,
  type ReviewerReviewSnapshot,
} from "./contracts.js";

export const REVIEWER_AUDIT_FINDING_MAX_LENGTH = 512;

const EVIDENCE_ASSESSMENT_STATUSES = Object.freeze([
  "supports",
  "does_not_establish",
  "contradicts",
] as const);
const COMPLETION_ASSESSMENT_STATUSES = Object.freeze([
  "satisfied",
  "gap",
  "indeterminate",
] as const);

type EvidenceAssessmentStatus =
  (typeof EVIDENCE_ASSESSMENT_STATUSES)[number];
type CompletionAssessmentStatus =
  (typeof COMPLETION_ASSESSMENT_STATUSES)[number];

export type ReviewerAuditCoverage = Readonly<{
  requiresGapVerdict: boolean;
  completionEvidenceRefCount: number;
}>;

export function createReviewerAuditCoverageSchema(
  snapshot: ReviewerReviewSnapshot,
  options: Readonly<{ minimumCompletionEvidenceRefs: number }>,
): Record<string, unknown> {
  const evidenceRefs = snapshot.evidence.map(({ evidenceRef }) => evidenceRef);
  return exactObject({
    evidenceAssessments: {
      type: "array",
      minItems: evidenceRefs.length,
      maxItems: evidenceRefs.length,
      items: exactObject({
        evidenceRef: enumString(evidenceRefs),
        status: enumString(EVIDENCE_ASSESSMENT_STATUSES),
        finding: boundedText(REVIEWER_AUDIT_FINDING_MAX_LENGTH),
      }),
    },
    completionAssessment: exactObject({
      status: enumString(COMPLETION_ASSESSMENT_STATUSES),
      evidenceRefs: {
        type: "array",
        minItems: options.minimumCompletionEvidenceRefs,
        maxItems: evidenceRefs.length,
        items: enumString(evidenceRefs),
      },
      finding: boundedText(REVIEWER_AUDIT_FINDING_MAX_LENGTH),
    }),
  });
}

export function parseReviewerAuditCoverage(
  value: unknown,
  snapshot: ReviewerReviewSnapshot,
  issues: ReviewerDecisionValidationIssue[],
): ReviewerAuditCoverage | undefined {
  const record = asRecord(value);
  if (!record) {
    issues.push(issue("reviewer_audit_invalid", "decision.audit"));
    return undefined;
  }
  exactKeys(
    record,
    ["evidenceAssessments", "completionAssessment"],
    "decision.audit",
    issues,
  );

  const evidenceAssessment = parseEvidenceAssessments(
    record.evidenceAssessments,
    snapshot,
    issues,
  );
  const completionAssessment = parseCompletionAssessment(
    record.completionAssessment,
    snapshot,
    issues,
  );
  if (!evidenceAssessment || !completionAssessment) return undefined;

  return Object.freeze({
    requiresGapVerdict:
      evidenceAssessment.hasContradiction ||
      completionAssessment.status !== "satisfied",
    completionEvidenceRefCount: completionAssessment.evidenceRefCount,
  });
}

function parseEvidenceAssessments(
  value: unknown,
  snapshot: ReviewerReviewSnapshot,
  issues: ReviewerDecisionValidationIssue[],
): Readonly<{ hasContradiction: boolean }> | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== snapshot.evidence.length ||
    value.length > REVIEWER_MAX_EVIDENCE
  ) {
    issues.push(
      issue(
        "reviewer_evidence_assessment_coverage_invalid",
        "decision.audit.evidenceAssessments",
      ),
    );
    return undefined;
  }

  const allowedRefs = new Set(
    snapshot.evidence.map(({ evidenceRef }) => evidenceRef),
  );
  const assessedRefs = new Set<string>();
  let hasContradiction = false;
  value.forEach((entry, index) => {
    const path = `decision.audit.evidenceAssessments[${index}]`;
    const assessment = asRecord(entry);
    if (!assessment) {
      issues.push(issue("reviewer_evidence_assessment_invalid", path));
      return;
    }
    exactKeys(
      assessment,
      ["evidenceRef", "status", "finding"],
      path,
      issues,
    );
    const evidenceRef = assessment.evidenceRef;
    if (typeof evidenceRef !== "string" || !allowedRefs.has(evidenceRef)) {
      issues.push(
        issue(
          "reviewer_evidence_assessment_ref_unknown",
          `${path}.evidenceRef`,
        ),
      );
    } else if (assessedRefs.has(evidenceRef)) {
      issues.push(
        issue(
          "reviewer_evidence_assessment_ref_duplicate",
          `${path}.evidenceRef`,
        ),
      );
    } else {
      assessedRefs.add(evidenceRef);
    }
    const status = assessment.status;
    if (!isEvidenceAssessmentStatus(status)) {
      issues.push(
        issue("reviewer_evidence_assessment_status_invalid", `${path}.status`),
      );
    } else if (status === "contradicts") {
      hasContradiction = true;
    }
    parseFinding(assessment.finding, `${path}.finding`, issues);
  });
  if (assessedRefs.size !== allowedRefs.size) {
    issues.push(
      issue(
        "reviewer_evidence_assessment_coverage_invalid",
        "decision.audit.evidenceAssessments",
      ),
    );
  }
  return Object.freeze({ hasContradiction });
}

function parseCompletionAssessment(
  value: unknown,
  snapshot: ReviewerReviewSnapshot,
  issues: ReviewerDecisionValidationIssue[],
): Readonly<{
  status: CompletionAssessmentStatus;
  evidenceRefCount: number;
}> | undefined {
  const record = asRecord(value);
  if (!record) {
    issues.push(
      issue(
        "reviewer_completion_assessment_invalid",
        "decision.audit.completionAssessment",
      ),
    );
    return undefined;
  }
  exactKeys(
    record,
    ["status", "evidenceRefs", "finding"],
    "decision.audit.completionAssessment",
    issues,
  );
  const status = record.status;
  if (!isCompletionAssessmentStatus(status)) {
    issues.push(
      issue(
        "reviewer_completion_assessment_status_invalid",
        "decision.audit.completionAssessment.status",
      ),
    );
  }
  const evidenceRefCount = parseEvidenceRefs(
    record.evidenceRefs,
    snapshot,
    "decision.audit.completionAssessment.evidenceRefs",
    issues,
  );
  parseFinding(
    record.finding,
    "decision.audit.completionAssessment.finding",
    issues,
  );
  return isCompletionAssessmentStatus(status)
    ? Object.freeze({ status, evidenceRefCount })
    : undefined;
}

function parseEvidenceRefs(
  value: unknown,
  snapshot: ReviewerReviewSnapshot,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): number {
  if (!Array.isArray(value) || value.length > snapshot.evidence.length) {
    issues.push(issue("reviewer_audit_evidence_refs_invalid", path));
    return 0;
  }
  const allowed = new Set(
    snapshot.evidence.map(({ evidenceRef }) => evidenceRef),
  );
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      issues.push(issue("reviewer_audit_evidence_ref_unknown", `${path}[${index}]`));
    } else if (seen.has(entry)) {
      issues.push(
        issue("reviewer_audit_evidence_ref_duplicate", `${path}[${index}]`),
      );
    } else {
      seen.add(entry);
    }
  });
  return seen.size;
}

function parseFinding(
  value: unknown,
  path: string,
  issues: ReviewerDecisionValidationIssue[],
): void {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length === 0 ||
    /[\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(normalized)
  ) {
    issues.push(issue("reviewer_audit_finding_invalid", path));
  }
}

function isEvidenceAssessmentStatus(
  value: unknown,
): value is EvidenceAssessmentStatus {
  return (
    typeof value === "string" &&
    (EVIDENCE_ASSESSMENT_STATUSES as readonly string[]).includes(value)
  );
}

function isCompletionAssessmentStatus(
  value: unknown,
): value is CompletionAssessmentStatus {
  return (
    typeof value === "string" &&
    (COMPLETION_ASSESSMENT_STATUSES as readonly string[]).includes(value)
  );
}

function exactObject(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function boundedText(maxLength: number): Record<string, unknown> {
  return { type: "string", minLength: 1, maxLength };
}

function enumString(values: readonly string[]): Record<string, unknown> {
  const uniqueValues = [...new Set(values)];
  return {
    type: "string",
    enum: uniqueValues.length > 0 ? uniqueValues : ["__none__"],
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
    issues.push(issue("reviewer_audit_shape_invalid", path));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function issue(
  code: string,
  path: string,
): ReviewerDecisionValidationIssue {
  return {
    code,
    path,
    message: `Reviewer audit failed ${code}.`,
  };
}
