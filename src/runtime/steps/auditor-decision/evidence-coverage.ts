import {
  projectAuditorEvidenceProjectionStatus,
  type AuditorAssignment,
  type AuditorDecisionValidationIssue,
} from "./contracts.js";
import { auditEvidenceSelectionIssue } from "./evidence-binding.js";
import { fingerprintAuditorBundle } from "./evidence-inventory.js";

export function validateAuditorEvidenceCoverage(
  value: Record<string, unknown>,
  assignment: AuditorAssignment,
): readonly AuditorDecisionValidationIssue[] {
  const needed = value.neededEvidenceIds;
  const notNeeded = value.notNeededEvidenceIds;
  if (!hasExactInventoryCoverage(needed, notNeeded, assignment)) {
    return issue(
      "auditor_evidence_coverage_invalid",
      "neededEvidenceIds and notNeededEvidenceIds must partition the complete inventory exactly once.",
    );
  }
  if (value.verdict === "needs_evidence")
    return validateRequestedBundle(
      value.requestedEvidenceIds,
      needed as string[],
      assignment,
    );
  if (!isEmptyEvidenceRequest(value.requestedEvidenceIds)) {
    return issue(
      "auditor_unexpected_evidence_request",
      "Only needs_evidence may request another bundle.",
    );
  }
  if (!requiresCurrentOriginalEvidence(value.verdict)) return [];
  if (!projectAuditorEvidenceProjectionStatus(assignment).complete) {
    return issue(
      `auditor_${value.verdict}_evidence_incomplete`,
      "Conclusive verdicts require all selected original evidence without omissions.",
    );
  }
  if (
    !hasCurrentNeededEvidence(needed as string[], assignment, value.verdict)
  ) {
    return issue(
      `auditor_${value.verdict}_needed_evidence_missing`,
      "Every needed evidence ID must be present in the current exact bundle; previews and prior reviews are not proof.",
    );
  }
  return [];
}

function hasExactInventoryCoverage(
  needed: unknown,
  notNeeded: unknown,
  assignment: AuditorAssignment,
): boolean {
  if (!Array.isArray(needed) || !Array.isArray(notNeeded)) return false;
  const ids = [...needed, ...notNeeded];
  if (ids.length !== assignment.availableEvidenceCount) return false;
  if (new Set(ids).size !== ids.length) return false;
  const inventoryIds = new Set(
    assignment.inventory.map((entry) => entry.executionId),
  );
  return ids.every((id) => typeof id === "string" && inventoryIds.has(id));
}

function requiresCurrentOriginalEvidence(
  verdict: unknown,
): verdict is "pass" | "gaps" {
  if (verdict === "pass") return true;
  return verdict === "gaps";
}

function hasCurrentNeededEvidence(
  needed: readonly string[],
  assignment: AuditorAssignment,
  verdict: "pass" | "gaps",
): boolean {
  if (needed.length === 0) return verdict === "gaps";
  const admitted = new Set(
    assignment.evidence.map((entry) => entry.executionId),
  );
  return needed.every((id) => admitted.has(id));
}

function validateRequestedBundle(
  ids: unknown,
  needed: readonly string[],
  assignment: AuditorAssignment,
): readonly AuditorDecisionValidationIssue[] {
  const currentBundle = fingerprintAuditorBundle(
    assignment.workFingerprint,
    assignment.selectedEvidenceIds,
  );
  const code = auditEvidenceSelectionIssue(ids, {
    ...assignment,
    reviewedBundleFingerprints: [
      ...assignment.reviewedBundleFingerprints,
      currentBundle,
    ],
  });
  if (code)
    return issue(
      code,
      "Request a complete admissible evidence bundle that has not already been reviewed for this work snapshot.",
    );
  if (!hasRequestedNeededEvidence(needed, ids as string[]))
    return issue(
      "auditor_requested_needed_evidence_missing",
      "The requested next bundle must include every needed evidence ID, including originals already read in the current bundle.",
    );
  return [];
}

function hasRequestedNeededEvidence(
  needed: readonly string[],
  requested: readonly string[],
): boolean {
  const requestedIds = new Set(requested);
  return needed.every((id) => requestedIds.has(id));
}

function isEmptyEvidenceRequest(ids: unknown): boolean {
  return Array.isArray(ids) && ids.length === 0;
}

function issue(
  code: string,
  message: string,
): readonly AuditorDecisionValidationIssue[] {
  return Object.freeze([{ code, path: "decision.evidenceCoverage", message }]);
}
