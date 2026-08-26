import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import {
  AUDITOR_DECISION_TEXT_MAX_LENGTH,
  projectAuditorEvidenceProjectionStatus,
  type AuditorAssignment,
  type AuditorDecision,
  type AuditorDecisionParseResult,
  type AuditorDecisionValidationIssue,
  type AuditorGap,
} from "./contracts.js";

export function parseAuditorDecisionOutput(
  text: string,
  assignment: AuditorAssignment,
): AuditorDecisionParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejected("json_envelope", [
      issue("auditor_output_not_json", "decision", "Expected one JSON object."),
    ]);
  }
  const envelope = readStructuredDecisionEnvelope(decoded);
  if (!envelope) {
    return rejected("json_envelope", [
      issue(
        "auditor_output_envelope_invalid",
        "decision",
        "Expected one decision inside the canonical envelope.",
      ),
    ]);
  }
  const issues: AuditorDecisionValidationIssue[] = [];
  exactKeys(
    envelope,
    ["auditId", "verdict", "criterionIds", "gaps"],
    "decision",
    issues,
  );
  if (envelope.auditId !== assignment.auditId) {
    issues.push(
      issue(
        "auditor_audit_id_mismatch",
        "decision.auditId",
        "auditId does not match the assigned audit.",
      ),
    );
  }
  const verdict =
    envelope.verdict === "pass" || envelope.verdict === "gaps"
      ? envelope.verdict
      : undefined;
  if (!verdict) {
    issues.push(
      issue(
        "auditor_verdict_invalid",
        "decision.verdict",
        "verdict must be pass or gaps.",
      ),
    );
  }
  if (!coversExactCriteria(envelope.criterionIds, assignment.criterionIds)) {
    issues.push(
      issue(
        "auditor_criterion_coverage_invalid",
        "decision.criterionIds",
        "criterionIds must cover the complete assigned set exactly once.",
      ),
    );
  }
  const gaps = parseGaps(envelope.gaps, assignment, issues);
  if (verdict === "pass" && gaps.inputCount !== 0) {
    issues.push(
      issue(
        "auditor_pass_gaps_invalid",
        "decision.gaps",
        "pass requires an empty gaps array.",
      ),
    );
  }
  if (
    verdict === "pass" &&
    !projectAuditorEvidenceProjectionStatus(assignment).complete
  ) {
    issues.push(
      issue(
        "auditor_pass_evidence_incomplete",
        "decision.verdict",
        "pass is unavailable because evidence is empty or omitted.",
      ),
    );
  }
  if (verdict === "gaps" && gaps.inputCount === 0) {
    issues.push(
      issue(
        "auditor_gaps_required",
        "decision.gaps",
        "gaps requires at least one mapped gap.",
      ),
    );
  }
  if (issues.length > 0 || !verdict) {
    return rejected("domain_parser", issues);
  }
  const decision: AuditorDecision =
    verdict === "pass"
      ? {
          auditId: assignment.auditId,
          verdict,
          criterionIds: [...assignment.criterionIds],
          gaps: [],
        }
      : {
          auditId: assignment.auditId,
          verdict,
          criterionIds: [...assignment.criterionIds],
          gaps: gaps.values,
        };
  return Object.freeze({
    ok: true as const,
    decision: deepFreeze(decision),
  });
}

function parseGaps(
  value: unknown,
  assignment: AuditorAssignment,
  issues: AuditorDecisionValidationIssue[],
): Readonly<{ values: readonly AuditorGap[]; inputCount: number }> {
  if (!Array.isArray(value) || value.length > assignment.criterionIds.length) {
    issues.push(
      issue(
        "auditor_gaps_invalid",
        "decision.gaps",
        "gaps must be a bounded array.",
      ),
    );
    return { values: [], inputCount: Array.isArray(value) ? value.length : 0 };
  }
  const allowed = new Set(assignment.criterionIds);
  const seen = new Set<string>();
  const gaps: AuditorGap[] = [];
  value.forEach((entry, index) => {
    const path = `decision.gaps.${index}`;
    if (!isRecord(entry)) {
      issues.push(
        issue("auditor_gap_invalid", path, "Expected one gap object."),
      );
      return;
    }
    exactKeys(entry, ["criterionId", "description"], path, issues);
    const criterionId =
      typeof entry.criterionId === "string" && allowed.has(entry.criterionId)
        ? entry.criterionId
        : undefined;
    if (!criterionId) {
      issues.push(
        issue(
          "auditor_gap_criterion_invalid",
          `${path}.criterionId`,
          "Gap criterionId is outside the assigned scope.",
        ),
      );
    } else if (seen.has(criterionId)) {
      issues.push(
        issue(
          "auditor_gap_criterion_duplicate",
          `${path}.criterionId`,
          "Each criterion may have at most one gap.",
        ),
      );
    } else {
      seen.add(criterionId);
    }
    const description = boundedText(entry.description);
    if (!description) {
      issues.push(
        issue(
          "auditor_gap_description_invalid",
          `${path}.description`,
          "Gap description must be bounded non-empty text.",
        ),
      );
    }
    if (criterionId && description) gaps.push({ criterionId, description });
  });
  return Object.freeze({
    values: Object.freeze(gaps),
    inputCount: value.length,
  });
}

function coversExactCriteria(
  value: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length &&
    expected.every((criterionId) => value.includes(criterionId))
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: AuditorDecisionValidationIssue[],
): void {
  const expectedSet = new Set(expected);
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expectedSet.has(key))
  ) {
    issues.push(
      issue(
        "auditor_decision_shape_invalid",
        path,
        `Expected exactly: ${expected.join(", ")}.`,
      ),
    );
  }
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= AUDITOR_DECISION_TEXT_MAX_LENGTH
    ? normalized
    : undefined;
}

function issue(
  code: string,
  path: string,
  message: string,
): AuditorDecisionValidationIssue {
  return Object.freeze({ code, path, message });
}

function rejected(
  stage: "json_envelope" | "domain_parser",
  issues: readonly AuditorDecisionValidationIssue[],
): AuditorDecisionParseResult {
  return Object.freeze({
    ok: false as const,
    stage,
    issues: Object.freeze([...issues]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}
