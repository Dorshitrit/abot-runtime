import type {
  SemanticCompactionCheckpoint,
  SemanticCompactionSource,
} from "./contracts.js";
import {
  createRequestContextCompactionStore,
  type RequestContextCompactionStore,
} from "./store.js";
import type { InvalidatedCompactionScope } from "./scope-quarantine.js";

export type RequestContextCompactionSnapshot = Readonly<{
  kind: "request_context_compaction_v1";
  checkpoints: readonly SemanticCompactionCheckpoint[];
  sources: readonly SemanticCompactionSource[];
  invalidatedScopes?: readonly InvalidatedCompactionScope[];
}>;

export function captureRequestContextCompaction(
  store: RequestContextCompactionStore,
): RequestContextCompactionSnapshot {
  if (!store.snapshot)
    throw new Error("context_compaction_snapshot_unavailable");
  return store.snapshot();
}

export function restoreRequestContextCompaction(
  snapshot: RequestContextCompactionSnapshot,
  options?: Readonly<{ restoreSuperQuarantine: true }>,
): RequestContextCompactionStore {
  if (snapshot?.kind !== "request_context_compaction_v1")
    throw new Error("context_compaction_snapshot_invalid");
  const records = options?.restoreSuperQuarantine
    ? snapshot.invalidatedScopes
    : undefined;
  if (records !== undefined && !Array.isArray(records))
    throw new Error("context_compaction_invalidation_invalid");
  if (
    records?.some((record) =>
      snapshot.checkpoints.some(
        (checkpoint) => checkpoint.scopeId === record.scopeId,
      ),
    )
  ) {
    throw new Error("context_compaction_invalidation_active_checkpoint");
  }
  const store = createRequestContextCompactionStore(
    records ? { invalidatedScopes: records } : undefined,
  );
  store.registerSources(snapshot.sources);
  for (const checkpoint of snapshot.checkpoints) {
    for (const source of checkpoint.sourceDigests) {
      if (!store.materializeSource(source.sourceRef, source.sourceFingerprint))
        throw new Error("context_compaction_snapshot_source_missing");
    }
    store.commit(checkpoint);
  }
  return store;
}
