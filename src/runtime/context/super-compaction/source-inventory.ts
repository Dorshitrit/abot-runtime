import {
  assertValidSemanticCompactionCheckpoint,
  assertValidSemanticCompactionCheckpointBinding,
  createSemanticCompactionSha256Fingerprint,
  sameSemanticCompactionCheckpointBinding,
  type SemanticCompactionSource,
} from "../semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../semantic-compaction/generation-contracts.js";
import { registerSemanticCompactionSources } from "../semantic-compaction/generation-source-registration.js";

/** Resolve canonical originals before generation; no summary becomes a new source. */
export function prepareSuperSourceInventory(
  params: SemanticCompactionGenerationParams,
): readonly SemanticCompactionSource[] {
  assertValidSemanticCompactionCheckpointBinding(params.binding);
  if (params.inheritedSourceDigests)
    throw new Error("super_compaction_inherited_sources_invalid");
  if (params.sources.length === 0)
    throw new Error("context_compaction_sources_empty");
  if (!hasCurrentRequestBinding(params))
    throw new Error("context_compaction_checkpoint_binding_invalid");
  const previous = params.previous;
  if (previous) assertValidSemanticCompactionCheckpoint(previous);
  if (
    previous &&
    !sameSemanticCompactionCheckpointBinding(previous, params.binding)
  )
    throw new Error("context_compaction_checkpoint_not_applicable");
  if (previous && previous.sourceRevision > params.sourceRevision)
    throw new Error("context_compaction_checkpoint_revision_invalid");
  const priorSources = (previous?.sourceDigests ?? []).map(
    ({ sourceRef, sourceFingerprint }) => {
      const source = params.request.contextCompactionStore?.materializeSource(
        sourceRef,
        sourceFingerprint,
      );
      if (!source) throw new Error("context_compaction_source_missing");
      return source;
    },
  );
  const sources = [...priorSources, ...params.sources];
  if (hasOverlappingSources(sources))
    throw new Error("context_compaction_source_identity_conflict");
  registerSemanticCompactionSources({ ...params, registrationMode: "atomic" });
  return Object.freeze(sources);
}

function hasCurrentRequestBinding(
  params: SemanticCompactionGenerationParams,
): boolean {
  if (params.binding.requestId !== params.request.requestId) return false;
  if (
    params.binding.currentRequestFingerprint !==
    createSemanticCompactionSha256Fingerprint(params.request.prompt)
  )
    return false;
  return (
    params.binding.objectiveFingerprint ===
    createSemanticCompactionSha256Fingerprint(params.preservationObjective)
  );
}

function hasOverlappingSources(
  sources: readonly SemanticCompactionSource[],
): boolean {
  return (
    new Set(sources.map((source) => source.sourceRef)).size !== sources.length
  );
}
