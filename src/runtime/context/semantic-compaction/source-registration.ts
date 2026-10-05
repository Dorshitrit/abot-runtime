import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "./contracts.js";
import { CompactionSourceInvariantError } from "../compaction-source-invariant.js";

/** Validate the complete SUPER batch before the source inventory can change. */
export function prepareAtomicCompactionSources(
  existing: ReadonlyMap<string, SemanticCompactionSource>,
  candidates: readonly SemanticCompactionSource[],
): readonly SemanticCompactionSource[] {
  const pending = new Map<string, SemanticCompactionSource>();
  for (const source of candidates) {
    if (!hasValidCompactionSourceContent(source)) {
      throw new CompactionSourceInvariantError(
        "context_compaction_source_invalid",
        typeof source?.sourceRef === "string" ? source.sourceRef : undefined,
      );
    }
    const previous =
      pending.get(source.sourceRef) ?? existing.get(source.sourceRef);
    if (hasConflictingCompactionSource(previous, source)) {
      throw new CompactionSourceInvariantError(
        "context_compaction_source_identity_conflict",
        source.sourceRef,
      );
    }
    pending.set(source.sourceRef, Object.freeze({ ...source }));
  }
  return Object.freeze([...pending.values()]);
}

function hasValidCompactionSourceContent(
  source: SemanticCompactionSource,
): boolean {
  if (typeof source?.sourceRef !== "string") return false;
  if (!source.sourceRef.trim()) return false;
  if (typeof source.content !== "string") return false;
  return (
    createSemanticCompactionSha256Fingerprint(source.content) ===
    source.sourceFingerprint
  );
}

function hasConflictingCompactionSource(
  previous: SemanticCompactionSource | undefined,
  candidate: SemanticCompactionSource,
): boolean {
  if (!previous) return false;
  if (previous.sourceFingerprint !== candidate.sourceFingerprint) return true;
  return previous.content !== candidate.content;
}
