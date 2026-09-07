import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type { SessionStore } from "../ports.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";

const temporaryDirectories: string[] = [];
const originalReceipt = {
  sessionId: "deleted",
  deleted: true,
  deletedMessages: 2,
  deletedRequests: 1,
};
const emptyReceipt = {
  ...originalReceipt,
  deleted: false,
  deletedMessages: 0,
  deletedRequests: 0,
};
type DeleteMethod = "deleteSession" | "deleteSessionWithStats";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(kind: "file" | "memory") {
  let base: SessionStore;
  if (kind === "file") {
    const sessionsDir = await mkdtemp(join(tmpdir(), "deletion-receipt-"));
    temporaryDirectories.push(sessionsDir);
    base = new SessionService({ sessionsDir });
  } else {
    base = createInMemorySessionStore();
  }
  const lifetime = createSessionLifecycleStore(base);
  await lifetime.store.appendMessage("deleted", "user", "question");
  await lifetime.store.appendMessage("deleted", "assistant", "answer");
  await lifetime.store.startRequestStream("deleted", "request");
  const remove = vi.spyOn(base, "deleteSessionWithStats");
  return { base, lifetime, remove };
}

describe.each(["file", "memory"] as const)(
  "undelivered deletion receipt over %s",
  (kind) => {
    const methods: DeleteMethod[] = ["deleteSession", "deleteSessionWithStats"];
    test.each(
      methods.flatMap((first) =>
        methods.map((retry) => [first, retry] as const),
      ),
    )(
      "%s failure preserves the original result for a later %s",
      async (first, retry) => {
        const { base, lifetime, remove } = await fixture(kind);
        const failed = vi
          .fn(async () => undefined)
          .mockRejectedValueOnce(new Error("cleanup_failed"));
        const succeeded = vi.fn(async () => undefined);
        lifetime.onDeleted(failed);
        lifetime.onDeleted(succeeded);

        await expect(lifetime.store[first]("deleted")).rejects.toThrow(
          "cleanup_failed",
        );
        expect(await base.getSessionById("deleted")).toBeNull();
        expect(lifetime.isDeleted("deleted")).toBe(true);
        await expect(
          lifetime.store.appendMessage("deleted", "assistant", "late"),
        ).rejects.toMatchObject({ code: "session_deleted" });

        await expect(lifetime.store[retry]("deleted")).resolves.toEqual(
          retry === "deleteSession" ? true : originalReceipt,
        );
        expect(remove).toHaveBeenCalledOnce();
        expect(failed).toHaveBeenCalledTimes(2);
        expect(succeeded).toHaveBeenCalledOnce();
        await expect(
          lifetime.store.deleteSessionWithStats("deleted"),
        ).resolves.toEqual(emptyReceipt);
        await expect(lifetime.store.deleteSession("deleted")).resolves.toBe(
          false,
        );
        expect(failed).toHaveBeenCalledTimes(2);
      },
    );

    test("cleanup retry preserves false when the physical session was already absent", async () => {
      const { base, lifetime, remove } = await fixture(kind);
      await base.deleteSessionWithStats("deleted");
      remove.mockClear();
      const cleanup = vi
        .fn(async () => undefined)
        .mockRejectedValueOnce(new Error("cleanup_failed"));
      lifetime.onDeleted(cleanup);

      await expect(lifetime.store.deleteSession("deleted")).rejects.toThrow(
        "cleanup_failed",
      );
      expect(lifetime.isDeleted("deleted")).toBe(true);
      await expect(
        lifetime.store.deleteSessionWithStats("deleted"),
      ).resolves.toEqual(emptyReceipt);
      expect(remove).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledTimes(2);
      await expect(lifetime.store.deleteSession("deleted")).resolves.toBe(
        false,
      );
      expect(remove).toHaveBeenCalledTimes(2);
    });

    test("concurrent failures retain one receipt and concurrent successful retries consume it once", async () => {
      const { base, lifetime, remove } = await fixture(kind);
      let failCleanup!: (error: Error) => void;
      const cleanup = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            failCleanup = reject;
          }),
      );
      lifetime.onDeleted(cleanup);
      const first = lifetime.store
        .deleteSession("deleted")
        .catch((error: unknown) => error);
      const second = lifetime.store
        .deleteSessionWithStats("deleted")
        .catch((error: unknown) => error);
      await vi.waitFor(async () =>
        expect(await base.getSessionById("deleted")).toBeNull(),
      );
      const error = new Error("cleanup_failed");
      failCleanup(error);
      expect(await first).toBe(error);
      expect(await second).toBe(error);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();

      cleanup.mockResolvedValue(undefined);
      const [stats, repeated] = await Promise.all([
        lifetime.store.deleteSessionWithStats("deleted"),
        lifetime.store.deleteSession("deleted"),
      ]);
      expect(stats).toEqual(originalReceipt);
      expect(repeated).toBe(false);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledTimes(2);
      await expect(
        lifetime.store.deleteSessionWithStats("deleted"),
      ).resolves.toEqual(emptyReceipt);
    });
  },
);
