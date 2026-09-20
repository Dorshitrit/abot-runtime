import { ROLE_CALL_RESULT_MAX_LENGTH } from "../../orchestration/role-calls/index.js";
import type { AuditorAssignment, AuditorDecision } from "./contracts.js";
import { fingerprintAuditorBundle } from "./evidence-inventory.js";

export const AUDITOR_ADVISORY_KIND =
  "runtime_execution_agent_auditor_advisory_v1";
const EVIDENCE_BINDING_KIND = "runtime_auditor_evidence_binding_v1";

export type AuditorAdvisoryReceipt = Readonly<{
  auditId: string;
  verdict: "pass" | "gaps" | "needs_evidence" | "failed";
  requestedEvidenceIds: readonly string[];
  evidenceBinding: Readonly<{
    kind: typeof EVIDENCE_BINDING_KIND;
    workFingerprint: string;
    selectedEvidenceIds: readonly string[];
    bundleFingerprint: string | null;
  }>;
}>;

export function settleAuditorAdvisory(
  assignment: AuditorAssignment,
  decision: AuditorDecision,
) {
  const summary = serializeAuditorAdvisory(assignment, decision);
  if (!isAuditorAdvisorySummaryAdmissible(summary)) {
    return failedAuditorAdvisory(assignment, "auditor_result_not_admissible");
  }
  return Object.freeze({
    kind: "terminal" as const,
    outcome: "completed" as const,
    summary,
  });
}

export function serializeAuditorAdvisory(
  assignment: AuditorAssignment,
  decision: AuditorDecision,
): string {
  return JSON.stringify({
    kind: AUDITOR_ADVISORY_KIND,
    authority: "model_advisory",
    presenceEffect: "passive_result_not_execution_or_completion",
    ...decision,
    evidenceBinding: binding(assignment),
  });
}

export function isAuditorAdvisorySummaryAdmissible(summary: string): boolean {
  return summary.length <= ROLE_CALL_RESULT_MAX_LENGTH;
}

export function failedAuditorAdvisory(
  assignment: AuditorAssignment,
  reason: string,
) {
  return Object.freeze({
    kind: "terminal" as const,
    outcome: "failed" as const,
    summary: JSON.stringify({
      kind: AUDITOR_ADVISORY_KIND,
      authority: "runtime_validation",
      presenceEffect: "passive_result_not_execution_or_completion",
      auditId: assignment.auditId,
      verdict: "failed",
      requestedEvidenceIds: [],
      reason,
      evidenceBinding: binding(assignment),
    }),
  });
}

export function readAuditorAdvisoryReceipt(
  summary: string,
): AuditorAdvisoryReceipt | undefined {
  let value: unknown;
  try {
    value = JSON.parse(summary) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.kind !== AUDITOR_ADVISORY_KIND)
    return undefined;
  if (typeof value.auditId !== "string") return undefined;
  if (!isAuditorVerdict(value.verdict)) return undefined;
  if (!hasAdvisoryAuthority(value.authority, value.verdict)) return undefined;
  if (!isStringArray(value.requestedEvidenceIds)) return undefined;
  const source = value.evidenceBinding;
  if (!isRecord(source) || source.kind !== EVIDENCE_BINDING_KIND)
    return undefined;
  if (typeof source.workFingerprint !== "string") return undefined;
  if (!isStringArray(source.selectedEvidenceIds)) return undefined;
  const expectedBundle =
    source.selectedEvidenceIds.length > 0
      ? fingerprintAuditorBundle(
          source.workFingerprint,
          source.selectedEvidenceIds,
        )
      : null;
  if (source.bundleFingerprint !== expectedBundle) return undefined;
  return value as unknown as AuditorAdvisoryReceipt;
}

function binding(
  assignment: AuditorAssignment,
): AuditorAdvisoryReceipt["evidenceBinding"] {
  return Object.freeze({
    kind: EVIDENCE_BINDING_KIND,
    workFingerprint: assignment.workFingerprint,
    selectedEvidenceIds: assignment.selectedEvidenceIds,
    bundleFingerprint:
      assignment.selectedEvidenceIds.length > 0
        ? fingerprintAuditorBundle(
            assignment.workFingerprint,
            assignment.selectedEvidenceIds,
          )
        : null,
  });
}

function isAuditorVerdict(
  value: unknown,
): value is AuditorAdvisoryReceipt["verdict"] {
  return (
    value === "pass" ||
    value === "gaps" ||
    value === "needs_evidence" ||
    value === "failed"
  );
}

function hasAdvisoryAuthority(
  authority: unknown,
  verdict: AuditorAdvisoryReceipt["verdict"],
): boolean {
  if (verdict === "failed") return authority === "runtime_validation";
  return authority === "model_advisory";
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (!value.every((item) => typeof item === "string")) return false;
  return new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
