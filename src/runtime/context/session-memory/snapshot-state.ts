import { isDeepStrictEqual } from "node:util";
import type { SessionMemoryCheckpoint, SessionMemoryScope } from "../../../sessions/memory/contracts.js";
import { assertSessionMemoryScope } from "../../../sessions/memory/checkpoint-scope.js";
import { assertValidSessionMemoryCheckpoint } from "../../../sessions/memory/rules.js";
import {
  resolveCoveredTurnCount,
  snapshotSessionMemorySource,
  type SessionMemorySourceSnapshot,
} from "../../../sessions/memory/source.js";

export type RequestSessionMemorySnapshot = Readonly<{
  kind: "request_session_memory_v1";
  scope?: SessionMemoryScope;
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
  assertSessionMemoryScope(snapshot.scope);
  if (snapshot.scope !== snapshot.source.scope)
    throw new Error("session_memory_snapshot_scope_invalid");
  const source = snapshotSessionMemorySource({
    messages: [...snapshot.source.historyMessages],
  }, snapshot.scope);
  if (!isDeepStrictEqual(source, snapshot.source))
    throw new Error("session_memory_snapshot_source_invalid");
  if (snapshot.checkpoint)
    assertValidSessionMemoryCheckpoint(snapshot.checkpoint);
  if (resolveCoveredTurnCount(source, snapshot.checkpoint) === undefined)
    throw new Error("session_memory_snapshot_coverage_invalid");
  return Object.freeze({ ...snapshot, source });
}
