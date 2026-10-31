import type { SessionRecord } from "../types.js";
import type { SessionMemoryCheckpoint, SessionMemoryScope } from "./contracts.js";

type SessionMemoryCheckpointSlots = Pick<
  SessionRecord,
  "sessionMemoryCheckpoint" | "executionSessionMemoryCheckpoint"
>;

export function assertSessionMemoryScope(scope: unknown): asserts scope is SessionMemoryScope | undefined {
  if (scope === undefined) return;
  if (isExecutionSessionMemoryScope(scope)) return;
  throw new Error("session_memory_scope_invalid");
}

export function isExecutionSessionMemoryScope(scope: unknown): scope is SessionMemoryScope {
  return scope === "execution_agent";
}

export function getSessionMemoryCheckpoint(
  session: SessionMemoryCheckpointSlots,
  scope?: SessionMemoryScope,
): SessionMemoryCheckpoint | undefined {
  if (isExecutionSessionMemoryScope(scope)) return session.executionSessionMemoryCheckpoint;
  return session.sessionMemoryCheckpoint;
}

export function setSessionMemoryCheckpoint(
  session: SessionMemoryCheckpointSlots,
  checkpoint: SessionMemoryCheckpoint,
  scope?: SessionMemoryScope,
): void {
  if (isExecutionSessionMemoryScope(scope)) {
    session.executionSessionMemoryCheckpoint = checkpoint;
    return;
  }
  session.sessionMemoryCheckpoint = checkpoint;
}

export function clearSessionMemoryCheckpoints(session: SessionMemoryCheckpointSlots): void {
  delete session.sessionMemoryCheckpoint;
  delete session.executionSessionMemoryCheckpoint;
}
