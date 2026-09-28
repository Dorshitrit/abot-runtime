import { isDeepStrictEqual } from "node:util";
import type { SessionMemoryCheckpoint } from "../../../sessions/memory/contracts.js";
import { assertValidSessionMemoryCheckpoint } from "../../../sessions/memory/rules.js";
import {
  resolveCoveredTurnCount,
  snapshotSessionMemorySource,
  type SessionMemorySourceSnapshot,
} from "../../../sessions/memory/source.js";

export type RequestSessionMemorySnapshot = Readonly<{
  kind: "request_session_memory_v1";
  source: SessionMemorySourceSnapshot;
  checkpoint?: SessionMemoryCheckpoint;
  persistedCheckpointRevision: number;
}>;

export function validateRequestSessionMemorySnapshot(
  snapshot: RequestSessionMemorySnapshot,
): RequestSessionMemorySnapshot {
  if (snapshot?.kind !== "request_session_memory_v1")
    throw new Error("session_memory_snapshot_invalid");
  if (!Number.isSafeInteger(snapshot.persistedCheckpointRevision))
    throw new Error("session_memory_snapshot_revision_invalid");
  if (snapshot.persistedCheckpointRevision < 0)
    throw new Error("session_memory_snapshot_revision_invalid");
  const source = snapshotSessionMemorySource({
    messages: [...snapshot.source.historyMessages],
  });
  if (!isDeepStrictEqual(source, snapshot.source))
    throw new Error("session_memory_snapshot_source_invalid");
  if (snapshot.checkpoint)
    assertValidSessionMemoryCheckpoint(snapshot.checkpoint);
  if (resolveCoveredTurnCount(source, snapshot.checkpoint) === undefined)
    throw new Error("session_memory_snapshot_coverage_invalid");
  return Object.freeze({ ...snapshot, source });
}
