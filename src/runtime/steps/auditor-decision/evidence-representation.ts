import {
  findExactEvidencePath,
  type EvidenceValuePath,
} from "../../context/exact-evidence-match.js";
import { projectCompactedCapabilityResultReceipt } from "../../context/compacted-capability-result-receipt.js";
import type { AuditorCapabilityEvidence } from "./contracts.js";
import type { ExecutionCompactedSource } from "../../context/execution-compacted-evidence.js";

type SupplementField = "summary" | "referenceData" | "references";
type RepresentedFields = Partial<Record<SupplementField, EvidenceValuePath>>;

export type AuditorEvidenceRepresentation = Readonly<
  Omit<AuditorCapabilityEvidence, SupplementField | "adapterResult"> &
    Partial<
      Pick<AuditorCapabilityEvidence, SupplementField | "adapterResult">
    > & {
      representedFields?: Readonly<RepresentedFields>;
      compactedSourceEvidence?: ExecutionCompactedSource &
        Readonly<{
          kind: "runtime_compacted_source_evidence_v1";
          authority: "passive_reference_only";
          omissionMeaning: "summarized_detail_not_proven_absent";
        }>;
    }
>;

/** Canonical records and their exact adapter envelopes are never rewritten. */
export function projectAuditorEvidenceRepresentation(
  evidence: AuditorCapabilityEvidence,
  compactedSource?: ExecutionCompactedSource,
): AuditorEvidenceRepresentation {
  if (compactedSource?.executionId === evidence.executionId) {
    const receipt = projectCompactedCapabilityResultReceipt(evidence);
    return Object.freeze({
      ...receipt,
      compactedSourceEvidence: Object.freeze({
        ...compactedSource,
        kind: "runtime_compacted_source_evidence_v1" as const,
        authority: "passive_reference_only" as const,
        omissionMeaning: "summarized_detail_not_proven_absent" as const,
      }),
    });
  }
  const represented: {
    -readonly [Key in keyof AuditorEvidenceRepresentation]: AuditorEvidenceRepresentation[Key];
  } = {
    ...evidence,
  };
  const representedFields: RepresentedFields = {};
  for (const field of ["summary", "referenceData", "references"] as const) {
    const supplement = evidence[field];
    if (supplement === undefined) continue;
    const path = findExactEvidencePath(evidence.adapterResult, supplement);
    if (!path) continue;
    delete represented[field];
    representedFields[field] = path;
  }
  return Object.freeze({
    ...represented,
    ...(Object.keys(representedFields).length > 0
      ? { representedFields: Object.freeze(representedFields) }
      : {}),
  });
}
