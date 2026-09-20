import type { AuditorCapabilityEvidence } from "./contracts.js";

type SupplementField = "summary" | "referenceData" | "references";
type AdapterPath = readonly (string | number)[];
type RepresentedFields = Partial<Record<SupplementField, AdapterPath>>;

export type AuditorEvidenceRepresentation = Readonly<
  Omit<AuditorCapabilityEvidence, SupplementField> &
    Partial<Pick<AuditorCapabilityEvidence, SupplementField>> & {
      representedFields?: Readonly<RepresentedFields>;
    }
>;

/** Canonical records and their exact adapter envelopes are never rewritten. */
export function projectAuditorEvidenceRepresentation(
  evidence: AuditorCapabilityEvidence,
): AuditorEvidenceRepresentation {
  const represented: {
    -readonly [Key in keyof AuditorEvidenceRepresentation]: AuditorEvidenceRepresentation[Key];
  } = {
    ...evidence,
  };
  const representedFields: RepresentedFields = {};
  for (const field of ["summary", "referenceData", "references"] as const) {
    const supplement = evidence[field];
    if (supplement === undefined) continue;
    const path = findExactAdapterPath(evidence.adapterResult, supplement);
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

function findExactAdapterPath(
  adapterResult: unknown,
  supplement: string | AuditorCapabilityEvidence["references"],
): AdapterPath | undefined {
  const expectedArray = Array.isArray(supplement)
    ? JSON.stringify(supplement)
    : undefined;
  function visit(value: unknown, path: AdapterPath): AdapterPath | undefined {
    if (isExactSupplementValue(value, supplement, expectedArray))
      return Object.freeze([...path]);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const found = visit(value[index], [...path, index]);
        if (found) return found;
      }
      return undefined;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const found = visit(child, [...path, key]);
        if (found) return found;
      }
    }
    return undefined;
  }
  return visit(adapterResult, []);
}

function isExactSupplementValue(
  value: unknown,
  supplement: string | AuditorCapabilityEvidence["references"],
  expectedArray: string | undefined,
): boolean {
  if (typeof supplement === "string") return value === supplement;
  if (!Array.isArray(value) || expectedArray === undefined) return false;
  return JSON.stringify(value) === expectedArray;
}
