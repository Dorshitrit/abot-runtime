import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSessionStore } from "../../runtime/adapters/file-session-store.js";
import { createInMemorySessionStore } from "../../runtime/adapters/in-memory-session-store.js";
import type { SessionStore } from "../../runtime/ports.js";
import type { SessionRecord } from "../types.js";
import { EXECUTION_TOOL_OBSERVATION_KIND } from "./execution-observation.js";
import { SESSION_MEMORY_CHECKPOINT_KIND, type SessionMemoryScope } from "./contracts.js";
import { snapshotSessionMemorySource } from "./source.js";
import { resolveApplicableSessionMemoryCheckpoint } from "./rules.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function storeFor(kind: "file" | "memory"): Promise<SessionStore> {
  if (kind === "memory") return createInMemorySessionStore();
  const artifacts = resolve(".codex/artifacts/ea-tool-history-checkpoints");
  await mkdir(artifacts, { recursive: true });
  const sessionsDir = await mkdtemp(join(artifacts, "sessions-"));
  directories.push(sessionsDir);
  return createFileSessionStore({ sessionsDir });
}

async function addTurn(store: SessionStore): Promise<SessionRecord> {
  await store.appendMessage("history", "user", "Look up a value", { requestId: "request-1" });
  return store.appendMessage("history", "assistant", "Value found", {
    requestId: "request-1",
    observationContent: JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND,
      requestId: "request-1", results: [{ value: "EXACT_TOOL_VALUE" }] }),
  });
}

function commandFor(session: SessionRecord, scope?: SessionMemoryScope) {
  const source = snapshotSessionMemorySource(session, scope);
  return {
    ...(scope ? { scope } : {}), expectedSourceRevision: source.sourceRevision,
    expectedCheckpointRevision: 0,
    checkpoint: {
      kind: SESSION_MEMORY_CHECKPOINT_KIND, revision: 1, sourceRevision: source.sourceRevision,
      coveredMessages: source.messageReferences,
      summary: scope ? "EA summary with collected value" : "Conversation-only summary",
      createdAt: "2026-10-27T00:00:00.000Z",
    },
  };
}

describe.each(["file", "memory"] as const)("%s session memory checkpoint isolation", (kind) => {
  it("commits independent revisions and reloads each scope without replacing the other", async () => {
    const store = await storeFor(kind);
    const session = await addTurn(store);
    const ordinary = commandFor(session);
    const execution = commandFor(session, "execution_agent");
    await expect(store.compareAndSwapSessionMemoryCheckpoint(session.id, ordinary)).resolves.toEqual({ committed: true, checkpoint: ordinary.checkpoint });
    await expect(store.compareAndSwapSessionMemoryCheckpoint(session.id, execution)).resolves.toEqual({ committed: true, checkpoint: execution.checkpoint });
    const loaded = (await store.getSessionById(session.id))!;
    expect(loaded.sessionMemoryCheckpoint).toEqual(ordinary.checkpoint);
    expect(loaded.executionSessionMemoryCheckpoint).toEqual(execution.checkpoint);
    expect(resolveApplicableSessionMemoryCheckpoint(loaded)).toEqual(ordinary.checkpoint);
    expect(resolveApplicableSessionMemoryCheckpoint(loaded, "execution_agent")).toEqual(execution.checkpoint);
    await expect(store.compareAndSwapSessionMemoryCheckpoint(session.id, execution)).resolves.toEqual({ committed: false, reason: "checkpoint_revision_mismatch" });
  });

  it.each(["clear", "delete"] as const)("invalidates both summaries on %s", async (action) => {
    const store = await storeFor(kind);
    const session = await addTurn(store);
    await store.compareAndSwapSessionMemoryCheckpoint(session.id, commandFor(session));
    await store.compareAndSwapSessionMemoryCheckpoint(session.id, commandFor(session, "execution_agent"));
    if (action === "clear") await store.clearSessionMessages(session.id);
    else await store.deleteMessage(session.id, session.messages[1]!.id);
    const loaded = (await store.getSessionById(session.id))!;
    expect(loaded.sessionMemoryCheckpoint).toBeUndefined();
    expect(loaded.executionSessionMemoryCheckpoint).toBeUndefined();
  });

  it("rejects an EA checkpoint bound to changed evidence without invalidating ordinary history", async () => {
    const store = await storeFor(kind);
    const session = await addTurn(store);
    const changed = structuredClone(session);
    changed.messages[1]!.observationContent = JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND,
      requestId: "request-1", results: [{ value: "DIFFERENT_TOOL_VALUE" }] });
    await expect(store.compareAndSwapSessionMemoryCheckpoint(session.id, commandFor(changed, "execution_agent")))
      .resolves.toEqual({ committed: false, reason: "source_revision_mismatch" });
    await expect(store.compareAndSwapSessionMemoryCheckpoint(session.id, commandFor(changed)))
      .resolves.toMatchObject({ committed: true });
  });
});
