import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type { SessionStore } from "../ports.js";
import {
  createSessionLifecycleStore,
  isSessionDeletedError,
} from "../session/session-lifecycle-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createStore(kind: "file" | "memory"): Promise<SessionStore> {
  if (kind === "memory") return createInMemorySessionStore();
  const sessionsDir = await mkdtemp(join(tmpdir(), "session-lifecycle-"));
  temporaryDirectories.push(sessionsDir);
  return new SessionService({ sessionsDir });
}

function createGate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

const lateMutations: [string, (store: SessionStore) => Promise<unknown>][] = [
  ["creation", (store) => store.getOrCreateSession("deleted")],
  [
    "message",
    (store) => store.appendMessage("deleted", "assistant", "late result"),
  ],
  ["request stream", (store) => store.startRequestStream("deleted", "request")],
  [
    "request event",
    (store) =>
      store.appendRequestEvent("deleted", "request", {
        type: "request.completed",
      }),
  ],
  ["title", (store) => store.updateSessionTitle("deleted", "late title")],
  [
    "runtime mode",
    (store) => store.updateSessionRuntimeMode!("deleted", "reasoning"),
  ],
  [
    "context",
    (store) =>
      store.appendContextEntry!("deleted", {
        kind: "tool_observation",
        content: "late context",
        observationMeta: { kind: "stable_fact", carryPolicy: "always" },
      }),
  ],
  [
    "artifact",
    (store) =>
      store.upsertArtifactPaths!("deleted", [
        {
          target: "report.txt",
          sourceRequestId: "request",
          sourceExecutionId: "execution",
        },
      ]),
  ],
  [
    "checkpoint",
    (store) =>
      store.compareAndSwapSessionMemoryCheckpoint("deleted", {
        expectedSourceRevision: "old",
        expectedCheckpointRevision: 0,
        checkpoint: {
          kind: "runtime_session_memory_checkpoint_v1",
          revision: 1,
          sourceRevision: "old",
          coveredMessages: [],
          summary: "late summary",
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      }),
  ],
  ["reset", (store) => store.resetSession("deleted")],
  ["clear", (store) => store.clearSessionMessages("deleted")],
  ["message deletion", (store) => store.deleteMessage("deleted", "msg-1")],
  [
    "message deletion stats",
    (store) => store.deleteMessageWithStats("deleted", "msg-1"),
  ],
];

describe.each(["file", "memory"] as const)(
  "session lifetime over %s persistence",
  (kind) => {
    test("preserves ordinary creation, reads, reset, clear, and independent sessions", async () => {
      const base = await createStore(kind);
      const lifetime = createSessionLifecycleStore(base);
      const listener = vi.fn();
      lifetime.onDeleted(listener);
      const { store } = lifetime;
      await store.getOrCreateSession("live");
      await expect(store.appendRequestEvent("live", "", {})).rejects.toThrow();
      await store.appendMessage("live", "user", "question");
      await store.startRequestStream("live", "request");
      expect((await store.getSessionSnapshot("live"))?.messages).toHaveLength(
        1,
      );
      expect((await store.getRequestReplayById("request"))?.sessionId).toBe(
        "live",
      );
      expect((await store.updateSessionTitle("live", "title"))?.title).toBe(
        "title",
      );
      expect((await store.resetSession("live"))?.messageCount).toBe(0);
      await store.appendMessage("live", "assistant", "after reset");
      expect((await store.clearSessionMessages("live"))?.deletedMessages).toBe(
        1,
      );
      expect(lifetime.isDeleted("live")).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      await store.getOrCreateSession("other");
      await store.deleteSession("other");
      await store.appendMessage("live", "user", "still available");
      expect(
        (await store.getAllSessions()).map((session) => session.id),
      ).toEqual(["live"]);
      expect((await store.listSessions()).sessions).toHaveLength(1);
      expect(await store.getSessionById("other")).toBeNull();
    });

    test.each(lateMutations)(
      "rejects late %s without recreating a deleted session",
      async (_name, mutate) => {
        const base = await createStore(kind);
        const lifetime = createSessionLifecycleStore(base);
        await lifetime.store.appendMessage("deleted", "user", "original");
        await lifetime.store.deleteSession("deleted");
        const failure = await mutate(lifetime.store).catch(
          (error: unknown) => error,
        );
        expect(isSessionDeletedError(failure)).toBe(true);
        expect(failure).toMatchObject({
          code: "session_deleted",
          sessionId: "deleted",
        });
        expect(await base.getSessionById("deleted")).toBeNull();
      },
    );

    test("marks intent immediately and deletes after an in-flight write without running queued writes", async () => {
      const base = await createStore(kind);
      await base.getOrCreateSession("deleted");
      const entered = createGate();
      const release = createGate();
      const append = base.appendMessage.bind(base);
      vi.spyOn(base, "appendMessage").mockImplementationOnce(
        async (...args) => {
          entered.open();
          await release.waiting;
          return append(...args);
        },
      );
      const titleWrite = vi.spyOn(base, "updateSessionTitle");
      const lifetime = createSessionLifecycleStore(base);
      const listener = vi.fn();
      lifetime.onDeleted(listener);
      const activeWrite = lifetime.store.appendMessage(
        "deleted",
        "assistant",
        "already writing",
      );
      await entered.waiting;
      const queuedWrite = lifetime.store.updateSessionTitle(
        "deleted",
        "must not write",
      );
      const queuedResult = Promise.allSettled([queuedWrite]);
      const deletion = lifetime.store.deleteSessionWithStats("deleted");
      expect(lifetime.isDeleted("deleted")).toBe(true);
      expect(listener).toHaveBeenCalledWith("deleted");
      await expect(
        lifetime.store.startRequestStream("deleted", "late-request"),
      ).rejects.toMatchObject({ code: "session_deleted" });
      await lifetime.store.appendMessage(
        "independent",
        "user",
        "can write meanwhile",
      );
      release.open();
      await activeWrite;
      expect((await queuedResult)[0]).toMatchObject({
        status: "rejected",
        reason: { code: "session_deleted" },
      });
      expect(await deletion).toMatchObject({
        deleted: true,
        deletedMessages: 1,
      });
      expect(titleWrite).not.toHaveBeenCalled();
      expect(await base.getSessionById("deleted")).toBeNull();
    });

    test("notifies once, awaits cleanup, and preserves both deletion return contracts", async () => {
      const lifetime = createSessionLifecycleStore(await createStore(kind));
      await lifetime.store.getOrCreateSession("deleted");
      const cleanup = createGate();
      const listener = vi.fn(() => cleanup.waiting);
      lifetime.onDeleted(listener);
      const unsubscribed = vi.fn();
      lifetime.onDeleted(unsubscribed)();
      let completed = false;
      const deletion = lifetime.store
        .deleteSession("deleted")
        .then((result) => {
          completed = true;
          return result;
        });
      await Promise.resolve();
      expect(completed).toBe(false);
      cleanup.open();
      expect(await deletion).toBe(true);
      expect(
        await lifetime.store.deleteSessionWithStats("deleted"),
      ).toMatchObject({ deleted: false, deletedMessages: 0 });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(unsubscribed).not.toHaveBeenCalled();
    });

    test("deletion remains final when cleanup fails and a failed mutation does not poison other operations", async () => {
      const base = await createStore(kind);
      const lifetime = createSessionLifecycleStore(base);
      await expect(
        lifetime.store.getOrCreateSession("../invalid"),
      ).rejects.toThrow();
      await lifetime.store.getOrCreateSession("deleted");
      lifetime.onDeleted(() => {
        throw new Error("cleanup_failed");
      });
      await expect(lifetime.store.deleteSession("deleted")).rejects.toThrow(
        "cleanup_failed",
      );
      expect(await base.getSessionById("deleted")).toBeNull();
      await expect(
        lifetime.store.appendMessage("deleted", "assistant", "late"),
      ).rejects.toMatchObject({ code: "session_deleted" });
      await expect(
        lifetime.store.appendMessage("other", "user", "available"),
      ).resolves.toMatchObject({ id: "other" });
    });

    test("blocks new writes after failed physical deletion and permits deletion to be attempted again", async () => {
      const base = await createStore(kind);
      await base.getOrCreateSession("deleted");
      vi.spyOn(base, "deleteSessionWithStats").mockRejectedValueOnce(
        new Error("storage_failure"),
      );
      const lifetime = createSessionLifecycleStore(base);
      await expect(
        lifetime.store.deleteSessionWithStats("deleted"),
      ).rejects.toThrow("storage_failure");
      expect(lifetime.isDeleted("deleted")).toBe(true);
      await expect(
        lifetime.store.startRequestStream("deleted", "late"),
      ).rejects.toMatchObject({ code: "session_deleted" });
      expect(
        await lifetime.store.deleteSessionWithStats("deleted"),
      ).toMatchObject({ deleted: true });
      expect(await base.getSessionById("deleted")).toBeNull();
    });
  },
);

test("does not add optional methods to a third-party store", () => {
  const base = createInMemorySessionStore();
  delete base.appendContextEntry;
  delete base.upsertArtifactPaths;
  delete base.updateSessionRuntimeMode;
  const { store } = createSessionLifecycleStore(base);
  expect(store.appendContextEntry).toBeUndefined();
  expect(store.upsertArtifactPaths).toBeUndefined();
  expect(store.updateSessionRuntimeMode).toBeUndefined();
});
