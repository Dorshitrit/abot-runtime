import type {
  SemanticCompactionCheckpoint,
  SemanticCompactionSource,
} from "./contracts.js";
import {
  createRequestContextCompactionStore,
  type RequestContextCompactionStore,
} from "./store.js";

export type RequestContextCompactionSnapshot = Readonly<{
  kind: "request_context_compaction_v1";
  checkpoints: readonly SemanticCompactionCheckpoint[];
  sources: readonly SemanticCompactionSource[];
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
): RequestContextCompactionStore {
  if (snapshot?.kind !== "request_context_compaction_v1")
    throw new Error("context_compaction_snapshot_invalid");
  const store = createRequestContextCompactionStore();
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
