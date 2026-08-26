import {
  assertValidSemanticCompactionCheckpoint,
  createSemanticCompactionSha256Fingerprint,
  sameSemanticCompactionCheckpointBinding,
  SemanticCompactionCheckpoint,
  type SemanticCompactionSource,
} from "./contracts.js";

export type RequestContextCompactionStore = Readonly<{
  get(scopeId: string): SemanticCompactionCheckpoint | undefined;
  findByCallIds(
    callIds: readonly string[],
  ): readonly SemanticCompactionCheckpoint[];
  registerSources(sources: readonly SemanticCompactionSource[]): void;
  materializeSource(
    sourceRef: string,
    sourceFingerprint: string,
  ): SemanticCompactionSource | undefined;
  commit(checkpoint: SemanticCompactionCheckpoint): void;
}>;

export function createRequestContextCompactionStore(): RequestContextCompactionStore {
  const checkpoints = new Map<string, SemanticCompactionCheckpoint>();
  const sources = new Map<string, SemanticCompactionSource>();
  return Object.freeze({
    get(scopeId) {
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
    materializeSource(sourceRef, sourceFingerprint) {
      const source = sources.get(sourceRef);
      return source?.sourceFingerprint === sourceFingerprint
        ? source
        : undefined;
    },
    commit(checkpoint) {
      assertValidSemanticCompactionCheckpoint(checkpoint);
      const previous = checkpoints.get(checkpoint.scopeId);
      if (
        previous &&
        (!sameSemanticCompactionCheckpointBinding(previous, checkpoint) ||
          checkpoint.sourceRevision < previous.sourceRevision ||
          previous.sourceDigests.some(
            (previousDigest, index) =>
              checkpoint.sourceDigests[index]?.sourceRef !==
                previousDigest.sourceRef ||
              checkpoint.sourceDigests[index]?.sourceFingerprint !==
                previousDigest.sourceFingerprint ||
              checkpoint.sourceDigests[index]?.digest !== previousDigest.digest,
          ))
      ) {
        throw new Error("context_compaction_checkpoint_regression");
      }
      checkpoints.set(checkpoint.scopeId, freezeCheckpoint(checkpoint));
    },
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
