import { ROLE_CALL_RESULT_MAX_LENGTH } from "../../orchestration/role-calls/index.js";
import { serializeAuditorAdvisory } from "./advisory-receipt.js";
import {
  AUDITOR_DECISION_TEXT_MAX_LENGTH,
  type AuditorAssignment,
} from "./contracts.js";

// JSON uses at most six UTF-16 units per Unicode code point, including escapes.
const JSON_STRING_MAX_ESCAPE_CHARS_PER_CODE_POINT = 6;

export class AuditorAdvisoryCapacityError extends Error {
  constructor() {
    super("auditor_result_metadata_exceeds_budget");
    this.name = "AuditorAdvisoryCapacityError";
  }
}

export function getAuditorAdvisoryDescriptionMaxLength(
  assignment: AuditorAssignment,
): number {
  const ids = assignment.inventory.map(({ executionId }) => executionId);
  // All IDs in one partition is at least as large as any valid split. Reserving
  // every ID in the requested bundle preserves every offered evidence choice.
  const reservedEnvelope = serializeAuditorAdvisory(assignment, {
    auditId: assignment.auditId,
    verdict: "needs_evidence",
    criterionIds: assignment.criterionIds,
    gaps: assignment.criterionIds.map((criterionId) => ({
      criterionId,
      description: "",
    })),
    neededEvidenceIds: ids,
    notNeededEvidenceIds: [],
    requestedEvidenceIds: ids,
  });
  const remainingChars = ROLE_CALL_RESULT_MAX_LENGTH - reservedEnvelope.length;
  const escapedCharsPerDescriptionUnit =
    JSON_STRING_MAX_ESCAPE_CHARS_PER_CODE_POINT *
    assignment.criterionIds.length;
  const maxLength = Math.min(
    AUDITOR_DECISION_TEXT_MAX_LENGTH,
    Math.floor(remainingChars / escapedCharsPerDescriptionUnit),
  );
  if (!hasAuditorDescriptionCapacity(maxLength))
    throw new AuditorAdvisoryCapacityError();
  return maxLength;
}

function hasAuditorDescriptionCapacity(maxLength: number): boolean {
  if (!Number.isSafeInteger(maxLength)) return false;
  return maxLength >= 1;
}
