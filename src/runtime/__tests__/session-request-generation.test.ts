import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type { SessionStore } from "../ports.js";

type StoreKind = "disk" | "memory";
const temporaryDirectories: string[] = [];
const now = () => new Date("2026-09-10T10:00:00.000Z");
const completion = {
  type: "event",
  name: "tool.completed",
  executionId: "execution",
  ok: true,
};

async function createFixture(kind: StoreKind) {
  const artifacts = join(process.cwd(), ".codex", "artifacts");
  await mkdir(artifacts, { recursive: true });
  const sessionsDir = await mkdtemp(join(artifacts, "request-generation-"));
  temporaryDirectories.push(sessionsDir);
  const store: SessionStore =
    kind === "disk"
      ? createFileSessionStore({ sessionsDir, now })
      : createInMemorySessionStore({ now });
  return {
    store,
    reload: async (): Promise<SessionStore> =>
      kind === "disk"
        ? createFileSessionStore({ sessionsDir, now })
        : createInMemorySessionStore({
            now,
            initialSessions: await store.getAllSessions(),
          }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.each<StoreKind>(["disk", "memory"])(
  "%s request generation",
  (kind) => {
    test("persists one generation through appends, repeated start, and reload", async () => {
      const fixture = await createFixture(kind);
      await fixture.store.startRequestStream("chat", "request");
      const started = await fixture.store.getRequestReplayById("request");
      expect(started?.generation).toEqual(expect.any(String));
      expect(started?.generation).toMatch(/^[0-9a-f-]{36}$/);

      await fixture.store.appendMessage("chat", "user", "Question", {
        requestId: "request",
        source: "user",
      });
      await fixture.store.appendRequestEvent("chat", "request", completion);
      await fixture.store.appendRequestEvent("chat", "request", {
        type: "completed",
        output: "Answer",
      });
      await fixture.store.startRequestStream("chat", "request");
      expect(
        (await fixture.store.getRequestReplayById("request"))?.generation,
      ).toBe(started?.generation);

      const reloaded = await fixture.reload();
      const replay = await reloaded.getRequestReplayById("request");
      expect(replay?.generation).toBe(started?.generation);
      expect(replay?.events).toHaveLength(2);
      expect(replay?.finalState).toMatchObject({
        status: "completed",
        output: "Answer",
      });
      const snapshot = await reloaded.getSessionSnapshot("chat");
      expect(snapshot?.messages).toHaveLength(1);
      expect(snapshot?.requests[0]).not.toHaveProperty("generation");
      expect(replay?.events.every((event) => !("generation" in event))).toBe(
        true,
      );
    });

    test.each(["clear", "delete", "reset"] as const)(
      "%s does not give late events or steering a new request generation",
      async (operation) => {
        const fixture = await createFixture(kind);
        await fixture.store.startRequestStream("chat", "request");
        const original = await fixture.store.getRequestReplayById("request");
        expect(original?.generation).toEqual(expect.any(String));
        await fixture.store.appendRequestEvent("chat", "request", completion);

        if (operation === "delete") await fixture.store.deleteSession("chat");
        if (operation === "clear")
          await fixture.store.clearSessionMessages("chat");
        if (operation === "reset") await fixture.store.resetSession("chat");
        await fixture.store.appendMessage("chat", "user", "Continue", {
          requestId: "request",
          source: "user",
        });
        await fixture.store.appendRequestEvent("chat", "request", completion);
        await fixture.store.appendRequestEvent("chat", "request", {
          type: "completed",
          output: "Late answer",
        });
        const recreated = await fixture.store.getRequestReplayById("request");
        expect(recreated).not.toBeNull();
        expect(recreated).not.toHaveProperty("generation");
        expect(recreated?.events).toHaveLength(2);

        await fixture.store.startRequestStream("chat", "request");
        expect(
          await fixture.store.getRequestReplayById("request"),
        ).not.toHaveProperty("generation");
        const reloaded = await fixture.reload();
        expect(
          await reloaded.getRequestReplayById("request"),
        ).not.toHaveProperty("generation");

        await reloaded.startRequestStream("chat", "new-request");
        const next = await reloaded.getRequestReplayById("new-request");
        expect(next?.generation).toEqual(expect.any(String));
        expect(next?.generation).not.toBe(original?.generation);
      },
    );

    test("fresh start after clear changes generation even with identical IDs and clock", async () => {
      const { store } = await createFixture(kind);
      await store.startRequestStream("chat", "request");
      const original = await store.getRequestReplayById("request");
      await store.clearSessionMessages("chat");
      await store.startRequestStream("chat", "request");
      const replacement = await store.getRequestReplayById("request");
      expect(replacement?.generation).toEqual(expect.any(String));
      expect(replacement?.generation).not.toBe(original?.generation);
      expect(replacement?.events).toEqual([]);
    });

    test("legacy records remain replayable without acquiring generation on reopen", async () => {
      const fixture = await createFixture(kind);
      await fixture.store.appendRequestEvent("legacy", "old-request", {
        type: "completed",
        output: "Saved answer",
      });
      const reloaded = await fixture.reload();
      await reloaded.startRequestStream("legacy", "old-request");
      const replay = await reloaded.getRequestReplayById("old-request");
      expect(replay).not.toHaveProperty("generation");
      expect(replay?.finalState).toMatchObject({ output: "Saved answer" });
      await reloaded.startRequestStream("other", "other-request");
      expect(
        (await reloaded.getRequestReplayById("other-request"))?.generation,
      ).toEqual(expect.any(String));
      expect(
        await reloaded.getRequestReplayById("old-request"),
      ).not.toHaveProperty("generation");
    });
  },
);
