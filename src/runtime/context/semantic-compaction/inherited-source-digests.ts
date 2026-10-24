import type { ModelStep } from "../../../shared/model-steps.js";
import {
  createSemanticCompactionSha256Fingerprint,
  isSemanticCompactionSha256Fingerprint,
  SEMANTIC_COMPACTION_ID_MAX_LENGTH,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionDigest,
  type SemanticCompactionSource,
} from "./contracts.js";
import type { SemanticCompactionGenerationParams } from "./generation-contracts.js";

/** The EA owner validates predecessor lineage; generation verifies its exact sources. */
export function assertInheritedCompactionSourceDigests(
  params: SemanticCompactionGenerationParams,
): void {
  const inherited = params.inheritedSourceDigests;
  if (inherited === undefined) return;
  if (params.previous !== undefined)
    throw new Error("context_compaction_inheritance_previous_conflict");
  if (!hasExclusiveExecutionCompactionConsumers(params.binding.allowedConsumers))
    throw new Error("context_compaction_inheritance_consumer_invalid");
  if (!Number.isSafeInteger(params.sourceRevision) || params.sourceRevision < 0)
    throw new Error("context_compaction_inheritance_revision_invalid");
  if (!Array.isArray(inherited) || inherited.length === 0)
    throw new Error("context_compaction_inheritance_sources_invalid");
  const store = params.request.contextCompactionStore;
  if (!store) throw new Error("context_compaction_store_required");
  const newSourceRefs = new Set(params.sources.map(({ sourceRef }) => sourceRef));
  const inheritedRefs = new Set<string>();
  for (const digest of inherited) {
    if (!isWellFormedInheritedSourceDigest(digest))
      throw new Error("context_compaction_inheritance_digest_invalid");
    if (inheritedRefs.has(digest.sourceRef) || newSourceRefs.has(digest.sourceRef))
      throw new Error("context_compaction_inheritance_source_overlap");
    const source = store.materializeSource(digest.sourceRef, digest.sourceFingerprint);
    if (!hasExactInheritedSourceIdentity(source, digest))
      throw new Error("context_compaction_inheritance_source_missing");
    inheritedRefs.add(digest.sourceRef);
  }
}

/** Inherited evidence carries no old objective-dependent continuation. */
export function resolvePriorCompactionSourceDigests(
  params: SemanticCompactionGenerationParams,
): readonly SemanticCompactionDigest[] {
  return params.previous?.sourceDigests ?? params.inheritedSourceDigests ?? [];
}

/** After the first fold, only the real candidate bound to the new objective survives. */
export function projectCompactionBatchParams(
  params: SemanticCompactionGenerationParams,
  previous: SemanticCompactionCheckpoint | undefined,
  sources: readonly SemanticCompactionSource[],
): SemanticCompactionGenerationParams {
  return Object.freeze({
    ...params,
    previous,
    inheritedSourceDigests: previous ? undefined : params.inheritedSourceDigests,
    sources,
  });
}

function hasExclusiveExecutionCompactionConsumers(
  consumers: readonly ModelStep[],
): boolean {
  if (consumers.length === 0) return false;
  return consumers.every(isExecutionCompactionConsumer);
}

function isExecutionCompactionConsumer(consumer: ModelStep): boolean {
  return consumer === "execution.decision" || consumer === "execution.response";
}

function isWellFormedInheritedSourceDigest(
  digest: SemanticCompactionDigest,
): boolean {
  if (!digest || typeof digest !== "object") return false;
  if (typeof digest.sourceRef !== "string") return false;
  if (!digest.sourceRef.trim()) return false;
  if (digest.sourceRef !== digest.sourceRef.trim()) return false;
  if (digest.sourceRef.length > SEMANTIC_COMPACTION_ID_MAX_LENGTH) return false;
  if (!isSemanticCompactionSha256Fingerprint(digest.sourceFingerprint)) return false;
  if (typeof digest.digest !== "string" || !digest.digest.trim()) return false;
  return digest.digest === digest.digest.trim();
}

function hasExactInheritedSourceIdentity(
  source: SemanticCompactionSource | undefined,
  digest: SemanticCompactionDigest,
): boolean {
  if (!source || source.sourceRef !== digest.sourceRef) return false;
  if (source.sourceFingerprint !== digest.sourceFingerprint) return false;
  return (
    createSemanticCompactionSha256Fingerprint(source.content) ===
    digest.sourceFingerprint
  );
}
