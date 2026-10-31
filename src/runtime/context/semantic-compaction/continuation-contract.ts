/** Structural storage contract. Actual projected token budgets are enforced at admission. */
export const SEMANTIC_COMPACTION_TEXT_MAX_LENGTH = 2_000;
export const SEMANTIC_COMPACTION_LIST_MAX_COUNT = 24;

export type SemanticCompactionContinuation = Readonly<{
  /** Runtime-authored representation; omitted for legacy/structured continuations. */
  format?: "raw_handoff_v1";
  completed: readonly string[];
  currentState: string;
  findings: readonly string[];
  evidenceRefs: readonly string[];
  artifacts: readonly string[];
  decisions: readonly string[];
  failedApproaches: readonly string[];
  openWork: readonly string[];
  blockers: readonly string[];
  nextStep: string;
}>;

export function isValidSemanticCompactionContinuation(
  continuation: SemanticCompactionContinuation,
): boolean {
  if (!hasContinuationRecord(continuation)) return false;
  if (!hasSupportedContinuationFormat(continuation)) return false;
  if (!hasValidContinuationState(continuation)) return false;
  if (!isBoundedContinuationText(continuation.nextStep)) return false;
  return [
    continuation.completed,
    continuation.findings,
    continuation.evidenceRefs,
    continuation.artifacts,
    continuation.decisions,
    continuation.failedApproaches,
    continuation.openWork,
    continuation.blockers,
  ].every(isBoundedContinuationList);
}

function hasContinuationRecord(value: SemanticCompactionContinuation): boolean {
  return value !== null && typeof value === "object";
}

function hasSupportedContinuationFormat(
  value: SemanticCompactionContinuation,
): boolean {
  return value.format === undefined || value.format === "raw_handoff_v1";
}

function hasValidContinuationState(
  value: SemanticCompactionContinuation,
): boolean {
  // RAW contains the entire handoff, rather than one structured field. Keep it
  // verbatim; the complete checkpoint and consuming envelope must fit their budgets.
  if (value.format === "raw_handoff_v1")
    return isCanonicalContinuationText(value.currentState);
  return isBoundedContinuationText(value.currentState);
}

function isBoundedContinuationList(value: readonly string[]): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length > SEMANTIC_COMPACTION_LIST_MAX_COUNT) return false;
  return value.every(isBoundedContinuationText);
}

function isBoundedContinuationText(value: string): boolean {
  if (!isCanonicalContinuationText(value)) return false;
  return value.length <= SEMANTIC_COMPACTION_TEXT_MAX_LENGTH;
}

function isCanonicalContinuationText(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  return value === value.trim();
}
