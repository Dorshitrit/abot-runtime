import {
  assertValidSemanticCompactionCheckpoint,
  createSemanticCompactionSha256Fingerprint,
  sameSemanticCompactionCheckpointBinding,
  SemanticCompactionCheckpoint,
  type SemanticCompactionSource,
} from "./contracts.js";
import type { RequestContextCompactionSnapshot } from "./snapshot.js";
import { prepareAtomicCompactionSources } from "./source-registration.js";
import {
  freezeCompactionInvalidation,
  InvalidatedCompactionScopeError,
  type InvalidatedCompactionScope,
} from "./scope-quarantine.js";

export type RequestContextCompactionStore = Readonly<{
  snapshot?(): RequestContextCompactionSnapshot;
  get(scopeId: string): SemanticCompactionCheckpoint | undefined;
  findByCallIds(
    callIds: readonly string[],
  ): readonly SemanticCompactionCheckpoint[];
  registerSources(sources: readonly SemanticCompactionSource[]): void;
  registerSourcesAtomically?(
    sources: readonly SemanticCompactionSource[],
  ): void;
  quarantineScope?(record: InvalidatedCompactionScope): void;
  materializeSource(
    sourceRef: string,
    sourceFingerprint: string,
  ): SemanticCompactionSource | undefined;
  commit(checkpoint: SemanticCompactionCheckpoint): void;
}>;

export function createRequestContextCompactionStore(
  options?: Readonly<{
    invalidatedScopes?: readonly InvalidatedCompactionScope[];
  }>,
): RequestContextCompactionStore {
  const checkpoints = new Map<string, SemanticCompactionCheckpoint>();
  const sources = new Map<string, SemanticCompactionSource>();
  const invalidated = new Map<string, InvalidatedCompactionScope>();
  for (const record of options?.invalidatedScopes ?? []) {
    if (invalidated.has(record.scopeId))
      throw new Error("context_compaction_invalidation_duplicate");
    invalidated.set(record.scopeId, freezeCompactionInvalidation(record));
  }
  return Object.freeze({
    snapshot() {
      return Object.freeze({
        kind: "request_context_compaction_v1" as const,
        checkpoints: Object.freeze(
          [...checkpoints.values()].filter(
            (checkpoint) => !invalidated.has(checkpoint.scopeId),
          ),
        ),
        sources: Object.freeze([...sources.values()]),
        ...(invalidated.size
          ? { invalidatedScopes: Object.freeze([...invalidated.values()]) }
          : {}),
      });
    },
    get(scopeId) {
      const record = invalidated.get(scopeId);
      if (record) throw new InvalidatedCompactionScopeError(record);
      return checkpoints.get(scopeId);
    },
    findByCallIds(callIds) {
      if (
        !Array.isArray(callIds) ||
        new Set(callIds).size !== callIds.length ||
        callIds.some((callId) => !callId.trim())
      ) {
        throw new Error("context_compaction_call_ids_invalid");
      }
      const selected: SemanticCompactionCheckpoint[] = [];
      for (const callId of callIds) {
        for (const checkpoint of checkpoints.values()) {
          if (invalidated.has(checkpoint.scopeId)) continue;
          if (checkpoint.callId === callId) selected.push(checkpoint);
        }
      }
      return Object.freeze(selected);
    },
    registerSources(nextSources) {
      for (const source of nextSources) {
        if (
          !source.sourceRef.trim() ||
          createSemanticCompactionSha256Fingerprint(source.content) !==
            source.sourceFingerprint
        ) {
          throw new Error("context_compaction_source_invalid");
        }
        const previous = sources.get(source.sourceRef);
        if (
          previous &&
          (previous.sourceFingerprint !== source.sourceFingerprint ||
            previous.content !== source.content)
        ) {
          throw new Error("context_compaction_source_identity_conflict");
        }
        sources.set(source.sourceRef, Object.freeze({ ...source }));
      }
    },
    registerSourcesAtomically(nextSources) {
      const prepared = prepareAtomicCompactionSources(sources, nextSources);
      for (const source of prepared) sources.set(source.sourceRef, source);
    },
    quarantineScope(record) {
      const frozen = freezeCompactionInvalidation(record);
      const previous = invalidated.get(frozen.scopeId);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(frozen))
          throw new Error("context_compaction_invalidation_conflict");
        return;
      }
      const checkpoint = checkpoints.get(frozen.scopeId);
      if (!checkpoint)
        throw new Error("context_compaction_invalidation_checkpoint_missing");
      if (!sameSemanticCompactionCheckpointBinding(checkpoint, frozen.binding))
        throw new Error("context_compaction_invalidation_binding_invalid");
      invalidated.set(frozen.scopeId, frozen);
    },
    materializeSource(sourceRef, sourceFingerprint) {
      const source = sources.get(sourceRef);
      return source?.sourceFingerprint === sourceFingerprint
        ? source
        : undefined;
    },
    commit(checkpoint) {
      const invalidation = invalidated.get(checkpoint.scopeId);
      if (invalidation) throw new InvalidatedCompactionScopeError(invalidation);
      assertValidSemanticCompactionCheckpoint(checkpoint);
      const previous = checkpoints.get(checkpoint.scopeId);
      if (
        previous &&
        !preservesCompactionSourceCoverage(previous, checkpoint)
      ) {
        throw new Error("context_compaction_checkpoint_regression");
      }
      checkpoints.set(checkpoint.scopeId, freezeCheckpoint(checkpoint));
    },
  });
}

function preservesCompactionSourceCoverage(
  previous: SemanticCompactionCheckpoint,
  next: SemanticCompactionCheckpoint,
): boolean {
  if (!sameSemanticCompactionCheckpointBinding(previous, next)) return false;
  if (next.sourceRevision < previous.sourceRevision) return false;
  return previous.sourceDigests.every((source, index) => {
    const replacement = next.sourceDigests[index];
    if (replacement?.sourceRef !== source.sourceRef) return false;
    return replacement.sourceFingerprint === source.sourceFingerprint;
  });
}

function freezeCheckpoint(
  checkpoint: SemanticCompactionCheckpoint,
): SemanticCompactionCheckpoint {
  return Object.freeze({
    ...checkpoint,
    allowedConsumers: Object.freeze([...checkpoint.allowedConsumers]),
    continuation: Object.freeze({
      ...checkpoint.continuation,
      completed: Object.freeze([...checkpoint.continuation.completed]),
      findings: Object.freeze([...checkpoint.continuation.findings]),
      evidenceRefs: Object.freeze([...checkpoint.continuation.evidenceRefs]),
      artifacts: Object.freeze([...checkpoint.continuation.artifacts]),
      decisions: Object.freeze([...checkpoint.continuation.decisions]),
      failedApproaches: Object.freeze([
        ...checkpoint.continuation.failedApproaches,
      ]),
      openWork: Object.freeze([...checkpoint.continuation.openWork]),
      blockers: Object.freeze([...checkpoint.continuation.blockers]),
    }),
    sourceDigests: Object.freeze(
      checkpoint.sourceDigests.map((sourceDigest) =>
        Object.freeze({ ...sourceDigest }),
      ),
    ),
  });
}
