import { expect, test, vi } from "vitest";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { deleteSessionWithAttachments } from "../session/session-attachment-deletion.js";

function gate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

test("finalization captures the original physical attempt and concurrent failure never retries it", async () => {
  const base = createInMemorySessionStore();
  await base.appendMessage("deleted", "user", "saved question");
  await base.startRequestStream("deleted", "request");
  const physicalGate = gate();
  const originalDelete = base.deleteSessionWithStats.bind(base);
  const remove = vi
    .spyOn(base, "deleteSessionWithStats")
    .mockImplementationOnce(async (id) => {
      await physicalGate.waiting;
      return originalDelete(id);
    });
  const cleanupGate = gate();
  const failure = new Error("attachment_cleanup_failed");
  const finalize = vi
    .fn(async () => undefined)
    .mockImplementationOnce(async () => {
      await cleanupGate.waiting;
      throw failure;
    });
  const lifetime = createSessionLifecycleStore(base, finalize);
  const succeeded = vi.fn(async () => undefined);
  lifetime.onDeleted(succeeded);

  const first = lifetime.store
    .deleteSession("deleted")
    .catch((error: unknown) => error);
  const second = lifetime.store
    .deleteSessionWithStats("deleted")
    .catch((error: unknown) => error);
  expect(lifetime.isDeleted("deleted")).toBe(true);
  expect(finalize).not.toHaveBeenCalled();
  physicalGate.open();
  await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
  expect(await base.getSessionById("deleted")).toBeNull();
  cleanupGate.open();
  expect(await first).toBe(failure);
  expect(await second).toBe(failure);
  expect(remove).toHaveBeenCalledOnce();
  expect(finalize).toHaveBeenCalledOnce();

  await expect(
    lifetime.store.deleteSessionWithStats("deleted"),
  ).resolves.toEqual({
    sessionId: "deleted",
    deleted: true,
    deletedMessages: 1,
    deletedRequests: 1,
  });
  expect(finalize).toHaveBeenCalledTimes(2);
  expect(succeeded).toHaveBeenCalledOnce();
  await expect(lifetime.store.deleteSession("deleted")).resolves.toBe(false);
  expect(finalize).toHaveBeenCalledTimes(2);
});

test("physical deletion failure has priority and never starts finalization until an explicit retry succeeds", async () => {
  const base = createInMemorySessionStore();
  await base.getOrCreateSession("deleted");
  vi.spyOn(base, "deleteSessionWithStats").mockRejectedValueOnce(
    new Error("physical_failed"),
  );
  const finalize = vi.fn(async () => undefined);
  const lifetime = createSessionLifecycleStore(base, finalize);
  lifetime.onDeleted(
    vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("listener_failed")),
  );
  await expect(lifetime.store.deleteSession("deleted")).rejects.toThrow(
    "physical_failed",
  );
  expect(finalize).not.toHaveBeenCalled();
  await expect(lifetime.store.deleteSession("deleted")).resolves.toBe(true);
  expect(finalize).toHaveBeenCalledOnce();
});

test("successful finalization is not repeated when another cleanup listener must retry", async () => {
  const base = createInMemorySessionStore();
  await base.getOrCreateSession("deleted");
  const finalize = vi.fn(async () => undefined);
  const lifetime = createSessionLifecycleStore(base, finalize);
  lifetime.onDeleted(
    vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("listener_failed")),
  );
  await expect(lifetime.store.deleteSession("deleted")).rejects.toThrow(
    "listener_failed",
  );
  expect(finalize).toHaveBeenCalledOnce();
  await expect(lifetime.store.deleteSession("deleted")).resolves.toBe(true);
  expect(finalize).toHaveBeenCalledOnce();
  await expect(lifetime.store.deleteSession("absent")).resolves.toBe(false);
  expect(finalize).toHaveBeenCalledOnce();
});

test("compatibility consumers sharing adapters retain one failed attempt and do not repeat physical deletion", async () => {
  const sessions = createInMemorySessionStore();
  await sessions.appendMessage("deleted", "user", "saved question");
  const physical = vi.spyOn(sessions, "deleteSessionWithStats");
  const release = gate();
  const failure = new Error("attachment_cleanup_failed");
  const cleanup = vi
    .fn(async () => undefined)
    .mockImplementationOnce(async () => {
      await release.waiting;
      throw failure;
    });
  const attachments = {
    deleteSessionAttachments: cleanup,
  } as unknown as RuntimeAttachmentStore;
  const first = deleteSessionWithAttachments(
    sessions,
    attachments,
    "deleted",
  ).catch((error: unknown) => error);
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  const second = deleteSessionWithAttachments(
    sessions,
    attachments,
    "deleted",
  ).catch((error: unknown) => error);
  release.open();
  expect(await first).toBe(failure);
  expect(await second).toBe(failure);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(physical).toHaveBeenCalledOnce();
  await expect(
    deleteSessionWithAttachments(sessions, attachments, "deleted"),
  ).resolves.toEqual({
    sessionId: "deleted",
    deleted: true,
    deletedMessages: 1,
    deletedRequests: 0,
  });
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(physical).toHaveBeenCalledOnce();
  await expect(
    deleteSessionWithAttachments(sessions, attachments, "deleted"),
  ).resolves.toMatchObject({ deleted: false });
  expect(cleanup).toHaveBeenCalledTimes(2);
  await sessions.appendMessage("deleted", "user", "new raw-store lifetime");
  await expect(
    deleteSessionWithAttachments(sessions, attachments, "deleted"),
  ).resolves.toMatchObject({
    deleted: true,
    deletedMessages: 1,
  });
  expect(cleanup).toHaveBeenCalledTimes(3);
});

test("a synchronous listener can start another delete without overtaking the original physical barrier", async () => {
  const base = createInMemorySessionStore();
  await base.appendMessage("deleted", "user", "saved question");
  const finalize = vi.fn(async () => undefined);
  const lifetime = createSessionLifecycleStore(base, finalize);
  let reentrant: ReturnType<typeof base.deleteSessionWithStats> | undefined;
  lifetime.onDeleted((id) => {
    reentrant = lifetime.store.deleteSessionWithStats(id);
    void reentrant.catch(() => undefined);
  });
  const first = lifetime.store.deleteSession("deleted");
  expect(lifetime.isDeleted("deleted")).toBe(true);
  expect(reentrant).toBeDefined();
  await expect(first).resolves.toBe(true);
  await expect(reentrant).resolves.toMatchObject({
    deleted: false,
    deletedMessages: 0,
  });
  expect(finalize).toHaveBeenCalledOnce();
});
