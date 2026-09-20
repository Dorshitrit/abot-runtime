import {
  type AuditorAssignment,
  type AuditorCapabilityEvidence,
} from "./contracts.js";
import {
  fingerprintAuditorBundle,
  fingerprintAuditorEvidence,
} from "./evidence-inventory.js";

export class AuditorEvidenceAdmissionError extends Error {}

export function auditEvidenceSelectionIssue(
  ids: unknown,
  assignment: AuditorAssignment,
): string | undefined {
  if (!Array.isArray(ids) || ids.length === 0)
    return "auditor_evidence_selection_empty";
  if (new Set(ids).size !== ids.length) return "auditor_evidence_ids_duplicate";
  const inventoryById = new Map(
    assignment.inventory.map((entry) => [entry.executionId, entry]),
  );
  for (const id of ids) {
    if (typeof id !== "string") return "auditor_evidence_id_invalid";
    const entry = inventoryById.get(id);
    if (!entry) return "auditor_evidence_id_unknown";
  }
  const bundle = fingerprintAuditorBundle(
    assignment.workFingerprint,
    ids as string[],
  );
  if (assignment.reviewedBundleFingerprints.includes(bundle))
    return "auditor_evidence_bundle_already_reviewed";
  return undefined;
}

export function bindAuditorEvidence(
  assignment: AuditorAssignment,
  source: readonly AuditorCapabilityEvidence[],
  selectedEvidenceIds: readonly string[],
): AuditorAssignment {
  const issue = auditEvidenceSelectionIssue(selectedEvidenceIds, assignment);
  if (issue) throw new AuditorEvidenceAdmissionError(issue);
  const sourceById = new Map(source.map((entry) => [entry.executionId, entry]));
  const evidence = selectedEvidenceIds.map((id) => {
    const entry = sourceById.get(id);
    if (!entry)
      throw new AuditorEvidenceAdmissionError(
        "auditor_evidence_source_unavailable",
      );
    const expected = assignment.inventory.find(
      (item) => item.executionId === id,
    );
    if (fingerprintAuditorEvidence(entry) !== expected?.evidenceFingerprint) {
      throw new AuditorEvidenceAdmissionError(
        "auditor_evidence_source_changed",
      );
    }
    return entry;
  });
  return Object.freeze({
    ...assignment,
    selectedEvidenceIds: Object.freeze([...selectedEvidenceIds]),
    evidence: Object.freeze(evidence),
    omittedEvidenceCount: 0,
  });
}
