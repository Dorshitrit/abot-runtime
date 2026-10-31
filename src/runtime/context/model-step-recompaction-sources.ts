import { CompactionSourceInvariantError } from "./compaction-source-invariant.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionSource,
} from "./semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "./semantic-compaction/generation-contracts.js";
import type { RequestContextCompactionStore } from "./semantic-compaction/store.js";

type CompactionGenerationSources = Pick<
  SemanticCompactionGenerationParams,
  "sources" | "previous" | "inheritedSourceDigests"
>;

/** A replacement regenerates derived state from the same verified original bytes. */
export function resolveModelStepCompactionGenerationSources(params: Readonly<{
  store: RequestContextCompactionStore;
  previous?: SemanticCompactionCheckpoint;
  inherited?: SemanticCompactionCheckpoint;
  newSources: readonly SemanticCompactionSource[];
  recompactFromSources?: true;
}>): CompactionGenerationSources {
  if (params.recompactFromSources) {
    return {
      sources: materializeRecompactionSources(
        params.store,
        params.previous ?? params.inherited,
        params.newSources,
      ),
    };
  }
  if (params.previous) {
    return { previous: params.previous, sources: params.newSources };
  }
  if (params.inherited) {
    return {
      inheritedSourceDigests: params.inherited.sourceDigests,
      sources: params.newSources,
    };
  }
  return { sources: params.newSources };
}

function materializeRecompactionSources(
  store: RequestContextCompactionStore,
  evidence: SemanticCompactionCheckpoint | undefined,
  newSources: readonly SemanticCompactionSource[],
): readonly SemanticCompactionSource[] {
  const sources = new Map<string, SemanticCompactionSource>();
  for (const identity of evidence?.sourceDigests ?? []) {
    const source = store.materializeSource(
      identity.sourceRef,
      identity.sourceFingerprint,
    );
    if (!source) {
      throw new CompactionSourceInvariantError(
        "context_compaction_replacement_source_missing", identity.sourceRef,
      );
    }
    assertExactRecompactionSource(source, identity);
    sources.set(source.sourceRef, Object.freeze({ ...source }));
  }
  for (const source of newSources) {
    assertExactRecompactionSource(source, source);
    const previous = sources.get(source.sourceRef);
    if (previous) {
      assertExactRecompactionSource(source, previous);
      continue;
    }
    sources.set(source.sourceRef, Object.freeze({ ...source }));
  }
  return Object.freeze([...sources.values()]);
}

function assertExactRecompactionSource(
  source: SemanticCompactionSource,
  identity: Pick<SemanticCompactionSource, "sourceRef" | "sourceFingerprint">,
): void {
  if (hasExactRecompactionSource(source, identity)) return;
  throw new CompactionSourceInvariantError(
    "context_compaction_source_identity_conflict", identity.sourceRef,
  );
}

function hasExactRecompactionSource(
  source: SemanticCompactionSource,
  identity: Pick<SemanticCompactionSource, "sourceRef" | "sourceFingerprint">,
): boolean {
  if (source.sourceRef !== identity.sourceRef) return false;
  if (source.sourceFingerprint !== identity.sourceFingerprint) return false;
  return createSemanticCompactionSha256Fingerprint(source.content) === identity.sourceFingerprint;
}
