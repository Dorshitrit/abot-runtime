import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SESSION_MEMORY_CHECKPOINT_KIND,
  type SessionMemoryCheckpoint,
} from "../../sessions/memory/contracts.js";
import { snapshotSessionMemorySource } from "../../sessions/memory/source.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { SessionStore } from "../ports.js";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.each([
  ["file", createFileStore],
  ["in-memory", createMemoryStore],
] as const)("%s session memory store", (_name, createStore) => {
  it("commits with matching source and checkpoint revisions", async () => {
    const store = await createStore();
    const session = await appendTurn(store, "session-1", "request-1");
    const source = snapshotSessionMemorySource(session);
    const checkpoint = checkpointFor(source, 1);

    const result = await store.compareAndSwapSessionMemoryCheckpoint(
      session.id,
      {
        expectedSourceRevision: source.sourceRevision,
        expectedCheckpointRevision: 0,
        checkpoint,
      },
    );

    expect(result).toEqual({ committed: true, checkpoint });
    await expect(store.getSessionById(session.id)).resolves.toMatchObject({
      sessionMemoryCheckpoint: checkpoint,
    });
  });

  it("rejects a stale source without overwriting canonical state", async () => {
    const store = await createStore();
    const initial = await appendTurn(store, "session-1", "request-1");
    const staleSource = snapshotSessionMemorySource(initial);
    await appendTurn(store, "session-1", "request-2");

    const result = await store.compareAndSwapSessionMemoryCheckpoint(
      initial.id,
      {
        expectedSourceRevision: staleSource.sourceRevision,
        expectedCheckpointRevision: 0,
        checkpoint: checkpointFor(staleSource, 1),
      },
    );

    expect(result).toEqual({
      committed: false,
      reason: "source_revision_mismatch",
    });
    expect(
      (await store.getSessionById(initial.id))?.sessionMemoryCheckpoint,
    ).toBeUndefined();
  });

  it("invalidates a checkpoint when a covered message is deleted", async () => {
    const store = await createStore();
    const session = await appendTurn(store, "session-1", "request-1");
    const source = snapshotSessionMemorySource(session);
    await store.compareAndSwapSessionMemoryCheckpoint(session.id, {
      expectedSourceRevision: source.sourceRevision,
      expectedCheckpointRevision: 0,
      checkpoint: checkpointFor(source, 1),
    });

    await store.deleteMessage(session.id, session.messages[0]!.id);

    expect(
      (await store.getSessionById(session.id))?.sessionMemoryCheckpoint,
    ).toBeUndefined();
  });

  it("commits one settled turn containing a user steering update", async () => {
    const store = await createStore();
    await store.appendMessage("session-1", "user", "initial request", {
      requestId: "request-1",
    });
    await store.appendMessage("session-1", "user", "added constraint", {
      requestId: "request-1",
    });
    const session = await store.appendMessage(
      "session-1",
      "assistant",
      "final answer",
      { requestId: "request-1" },
    );
    const source = snapshotSessionMemorySource(session);

    const result = await store.compareAndSwapSessionMemoryCheckpoint(
      session.id,
      {
        expectedSourceRevision: source.sourceRevision,
        expectedCheckpointRevision: 0,
        checkpoint: checkpointFor(source, 1),
      },
    );

    expect(source.turns).toHaveLength(1);
    expect(source.messageReferences).toHaveLength(3);
    expect(result.committed).toBe(true);
  });
});

describe("file session memory restart", () => {
  it("reloads a committed checkpoint without rebuilding hidden state", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "abot-session-memory-"));
    temporaryDirectories.push(sessionsDir);
    const firstStore = createFileSessionStore({ sessionsDir });
    const session = await appendTurn(firstStore, "session-1", "request-1");
    const source = snapshotSessionMemorySource(session);
    const checkpoint = checkpointFor(source, 1);
    await firstStore.compareAndSwapSessionMemoryCheckpoint(session.id, {
      expectedSourceRevision: source.sourceRevision,
      expectedCheckpointRevision: 0,
      checkpoint,
    });

    const restartedStore = createFileSessionStore({ sessionsDir });
    const restartedSession = await restartedStore.getSessionById(session.id);

    expect(restartedSession?.messages).toEqual(
      session.messages.map((message) =>
        Object.fromEntries(
          Object.entries(message).filter(([, value]) => value !== undefined),
        ),
      ),
    );
    expect(restartedSession?.sessionMemoryCheckpoint).toEqual(checkpoint);
  });
});

async function createFileStore(): Promise<SessionStore> {
  const sessionsDir = await mkdtemp(join(tmpdir(), "abot-session-memory-"));
  temporaryDirectories.push(sessionsDir);
  return createFileSessionStore({ sessionsDir });
}

async function createMemoryStore(): Promise<SessionStore> {
  return createInMemorySessionStore();
}

async function appendTurn(
  store: SessionStore,
  sessionId: string,
  requestId: string,
): Promise<SessionRecord> {
  await store.appendMessage(sessionId, "user", `user ${requestId}`, {
    requestId,
  });
  return store.appendMessage(sessionId, "assistant", `assistant ${requestId}`, {
    requestId,
  });
}

function checkpointFor(
  source: ReturnType<typeof snapshotSessionMemorySource>,
  revision: number,
): SessionMemoryCheckpoint {
  return Object.freeze({
    kind: SESSION_MEMORY_CHECKPOINT_KIND,
    revision,
    sourceRevision: source.sourceRevision,
    coveredMessages: Object.freeze([...source.messageReferences]),
    summary: "The user and agent completed one settled exchange.",
    createdAt: "2026-08-25T00:00:00.000Z",
  });
}
