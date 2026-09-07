import { expect, test, vi } from "vitest";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";

function cleanupGate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

test("an explicit repeated deletion retries only the original failed cleanup", async () => {
  const base = createInMemorySessionStore();
  const lifetime = createSessionLifecycleStore(base);
  await lifetime.store.getOrCreateSession("deleted");
  const failed = vi
    .fn(async () => undefined)
    .mockRejectedValueOnce(new Error("cleanup_failed"));
  const succeeded = vi.fn(async () => undefined);
  const unsubscribeFailed = lifetime.onDeleted(failed);
  lifetime.onDeleted(succeeded);
  await expect(lifetime.store.deleteSession("deleted")).rejects.toThrow(
    "cleanup_failed",
  );
  expect(await base.getSessionById("deleted")).toBeNull();
  expect(lifetime.isDeleted("deleted")).toBe(true);
  await expect(
    lifetime.store.appendMessage("deleted", "assistant", "late"),
  ).rejects.toMatchObject({ code: "session_deleted" });

  unsubscribeFailed();
  const registeredLater = vi.fn(async () => undefined);
  lifetime.onDeleted(registeredLater);
  await expect(
    lifetime.store.deleteSessionWithStats("deleted"),
  ).resolves.toMatchObject({ deleted: true, deletedMessages: 0 });
  expect(failed).toHaveBeenCalledTimes(2);
  expect(succeeded).toHaveBeenCalledOnce();
  expect(registeredLater).not.toHaveBeenCalled();
  await expect(lifetime.store.deleteSession("deleted")).resolves.toBe(false);
  expect(failed).toHaveBeenCalledTimes(2);
  await lifetime.store.getOrCreateSession("other");
  await lifetime.store.deleteSession("other");
  expect(failed).toHaveBeenCalledTimes(2);
  expect(succeeded).toHaveBeenCalledTimes(2);
  expect(registeredLater).toHaveBeenCalledExactlyOnceWith("other");
});

test("concurrent deletes share cleanup until every original listener has settled", async () => {
  const lifetime = createSessionLifecycleStore(createInMemorySessionStore());
  await lifetime.store.getOrCreateSession("deleted");
  const gate = cleanupGate();
  const failure = new Error("cleanup_failed");
  const failed = vi.fn(async () => undefined).mockRejectedValueOnce(failure);
  const blocked = vi.fn(() => gate.waiting);
  lifetime.onDeleted(failed);
  lifetime.onDeleted(blocked);
  let firstSettled = false;
  const first = lifetime.store
    .deleteSession("deleted")
    .catch((error: unknown) => {
      firstSettled = true;
      return error;
    });
  expect(lifetime.isDeleted("deleted")).toBe(true);
  expect(blocked).toHaveBeenCalledOnce();
  await new Promise((resolve) => setImmediate(resolve));
  expect(firstSettled).toBe(false);
  const second = lifetime.store
    .deleteSessionWithStats("deleted")
    .catch((error: unknown) => error);
  await expect(
    lifetime.store.getOrCreateSession("deleted"),
  ).rejects.toMatchObject({ code: "session_deleted" });
  expect(failed).toHaveBeenCalledOnce();
  expect(blocked).toHaveBeenCalledOnce();
  gate.open();
  expect(await first).toBe(failure);
  expect(await second).toBe(failure);
  await lifetime.store.deleteSession("deleted");
  expect(failed).toHaveBeenCalledTimes(2);
  expect(blocked).toHaveBeenCalledOnce();
});

test("physical deletion errors keep precedence without replaying successful cleanup", async () => {
  const base = createInMemorySessionStore();
  await base.getOrCreateSession("deleted");
  vi.spyOn(base, "deleteSessionWithStats").mockRejectedValueOnce(
    new Error("physical_delete_failed"),
  );
  const lifetime = createSessionLifecycleStore(base);
  const failed = vi
    .fn(async () => undefined)
    .mockRejectedValueOnce(new Error("cleanup_failed"));
  const succeeded = vi.fn(async () => undefined);
  lifetime.onDeleted(failed);
  lifetime.onDeleted(succeeded);
  await expect(lifetime.store.deleteSession("deleted")).rejects.toThrow(
    "physical_delete_failed",
  );
  expect(lifetime.isDeleted("deleted")).toBe(true);
  await expect(
    lifetime.store.getOrCreateSession("deleted"),
  ).rejects.toMatchObject({ code: "session_deleted" });
  await expect(lifetime.store.deleteSession("deleted")).resolves.toBe(true);
  expect(await base.getSessionById("deleted")).toBeNull();
  expect(failed).toHaveBeenCalledTimes(2);
  expect(succeeded).toHaveBeenCalledOnce();
});
