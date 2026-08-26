import type { SessionRecord } from "../types.js";
import {
  SESSION_MEMORY_CHECKPOINT_KIND,
  SESSION_MEMORY_SUMMARY_MAX_CHARACTERS,
  type SessionMemoryCheckpoint,
  type SessionMemoryCheckpointCommit,
  type SessionMemoryCheckpointCommitResult,
} from "./contracts.js";
import {
  resolveCoveredTurnCount,
  snapshotSessionMemorySource,
} from "./source.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function assertValidSessionMemoryCheckpoint(
  checkpoint: SessionMemoryCheckpoint,
): void {
  const checkpointIsValid =
    hasValidCheckpointIdentity(checkpoint) &&
    hasValidCheckpointCoverage(checkpoint) &&
    hasValidCheckpointSummary(checkpoint) &&
    hasValidCheckpointTimestamp(checkpoint);
  if (!checkpointIsValid) {
    throw new Error("session_memory_checkpoint_invalid");
  }
}

export function resolveSessionMemoryCheckpointCommit(
  session: SessionRecord,
  command: SessionMemoryCheckpointCommit,
): SessionMemoryCheckpointCommitResult {
  const source = snapshotSessionMemorySource(session);
  if (source.sourceRevision !== command.expectedSourceRevision) {
    return Object.freeze({
      committed: false as const,
      reason: "source_revision_mismatch" as const,
    });
  }
  const currentCheckpointRevision =
    session.sessionMemoryCheckpoint?.revision ?? 0;
  if (currentCheckpointRevision !== command.expectedCheckpointRevision) {
    return Object.freeze({
      committed: false as const,
      reason: "checkpoint_revision_mismatch" as const,
    });
  }
  assertValidSessionMemoryCheckpoint(command.checkpoint);
  const expectedRevision = command.expectedCheckpointRevision + 1;
  const coveredTurnCount = resolveCoveredTurnCount(source, command.checkpoint);
  const checkpointIsBoundToCommit =
    command.checkpoint.revision === expectedRevision &&
    command.checkpoint.sourceRevision === command.expectedSourceRevision &&
    coveredTurnCount !== undefined;
  if (!checkpointIsBoundToCommit) {
    throw new Error("session_memory_checkpoint_binding_invalid");
  }
  return Object.freeze({
    committed: true as const,
    checkpoint: command.checkpoint,
  });
}

export function resolveApplicableSessionMemoryCheckpoint(
  session: SessionRecord,
): SessionMemoryCheckpoint | undefined {
  const checkpoint = session.sessionMemoryCheckpoint;
  if (!checkpoint) {
    return undefined;
  }
  try {
    assertValidSessionMemoryCheckpoint(checkpoint);
  } catch {
    return undefined;
  }
  const source = snapshotSessionMemorySource(session);
  return resolveCoveredTurnCount(source, checkpoint) === undefined
    ? undefined
    : checkpoint;
}

function hasValidCheckpointIdentity(
  checkpoint: SessionMemoryCheckpoint,
): boolean {
  return (
    checkpoint.kind === SESSION_MEMORY_CHECKPOINT_KIND &&
    Number.isSafeInteger(checkpoint.revision) &&
    checkpoint.revision >= 1 &&
    SHA256_PATTERN.test(checkpoint.sourceRevision)
  );
}

function hasValidCheckpointCoverage(
  checkpoint: SessionMemoryCheckpoint,
): boolean {
  const coverage = checkpoint.coveredMessages;
  if (coverage.length === 0) {
    return false;
  }
  return coverage.every(
    ({ messageId, fingerprint }) =>
      messageId.trim().length > 0 && SHA256_PATTERN.test(fingerprint),
  );
}

function hasValidCheckpointSummary(
  checkpoint: SessionMemoryCheckpoint,
): boolean {
  const summaryLength = checkpoint.summary.trim().length;
  return (
    summaryLength > 0 && summaryLength <= SESSION_MEMORY_SUMMARY_MAX_CHARACTERS
  );
}

function hasValidCheckpointTimestamp(
  checkpoint: SessionMemoryCheckpoint,
): boolean {
  return Number.isFinite(Date.parse(checkpoint.createdAt));
}
