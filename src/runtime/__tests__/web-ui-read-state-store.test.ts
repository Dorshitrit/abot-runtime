import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebReadStateStore } from "../../web-ui/session-read-state/store.js";
import {
  advanceReadCursor,
  projectSessionReadState,
} from "../../web-ui/session-read-state/projection.js";
import type { SessionSnapshotMessage } from "../../sessions/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "web-read-state-"));
  roots.push(root);
  const path = join(root, "state.json");
  const store = new WebReadStateStore(path, 1000);
  await store.initialize();
  return { store, path };
}
function message(
  id: number,
  role: "user" | "assistant",
  createdAt: number,
): SessionSnapshotMessage {
  return {
    id,
    role,
    createdAt,
    requestId: `request-${id}`,
    sessionId: "chat",
    text: "content",
    source: "request",
    cronJobId: null,
    cronTitle: null,
    triggerType: null,
  };
}
const messages = [
  message(1, "assistant", 900),
  message(2, "user", 1100),
  message(3, "assistant", 1200),
  message(4, "assistant", 1300),
];

describe("Web UI read state persistence", () => {
  test("one migration boundary survives restart, including a new Job never listed before", async () => {
    const { store, path } = await fixture();
    const read = await store.transaction((state) =>
      projectSessionReadState(state, "chat", messages),
    );
    expect(read.unreadCount).toBe(2);
    const restarted = new WebReadStateStore(path, 9000);
    await restarted.initialize();
    expect(
      await restarted.transaction(
        (state) =>
          projectSessionReadState(state, "new-job", [
            message(1, "assistant", 1400),
          ]).unreadCount,
      ),
    ).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8")).initializedAt).toBe(1000);
  });

  test("concurrent clients cannot roll a read cursor backward", async () => {
    const { store, path } = await fixture();
    const other = new WebReadStateStore(path, 5000);
    await Promise.all([
      store.transaction((state) =>
        advanceReadCursor(
          state,
          "chat",
          messages,
          { readThroughMessageId: 4 },
          1500,
        ),
      ),
      other.transaction((state) =>
        advanceReadCursor(
          state,
          "chat",
          messages,
          { readThroughMessageId: 3 },
          1600,
        ),
      ),
    ]);
    expect(
      await other.transaction((state) =>
        projectSessionReadState(state, "chat", messages),
      ),
    ).toMatchObject({ unreadCount: 0, lastReadMessageId: "4" });
  });

  test("successive read boundaries have distinct revisions even within one clock tick", async () => {
    const { store } = await fixture();
    const revisions = [];
    for (const id of [3, 4]) {
      const revision = await store.transaction((state) => {
        advanceReadCursor(
          state,
          "chat",
          messages,
          { readThroughMessageId: id },
          2000,
        );
        return projectSessionReadState(state, "chat", messages).lastReadAt;
      });
      revisions.push(revision);
    }
    expect(revisions).toEqual([2000, 2001]);
  });

  test("null, unknown and user message acknowledgements never read unseen assistant replies", async () => {
    const { store } = await fixture();
    for (const boundary of [
      { readThroughMessageId: null },
      { readThroughMessageId: 99 },
      { readThroughMessageId: 2 },
      { readThroughRequestId: "unknown" },
    ]) {
      await store.transaction((state) =>
        advanceReadCursor(state, "chat", messages, boundary, 2000),
      );
    }
    expect(
      await store.transaction(
        (state) => projectSessionReadState(state, "chat", messages).unreadCount,
      ),
    ).toBe(2);
  });

  test("a displayed completed request only reads through its own persisted assistant", async () => {
    const { store } = await fixture();
    await store.transaction((state) =>
      advanceReadCursor(
        state,
        "chat",
        messages,
        { readThroughRequestId: "request-3" },
        2000,
      ),
    );
    expect(
      await store.transaction((state) =>
        projectSessionReadState(state, "chat", messages),
      ),
    ).toMatchObject({ unreadCount: 1, lastReadMessageId: "3" });
  });

  test("clearing preserves a newer read revision across restart while reused message IDs remain unread", async () => {
    const { store, path } = await fixture();
    await store.transaction((state) =>
      advanceReadCursor(
        state, "chat", messages, { readThroughMessageId: 4 }, 2000,
      ),
    );

    await store.reset("chat", 1999);
    const cleared = await store.transaction((state) =>
      projectSessionReadState(state, "chat", []),
    );
    expect(cleared).toMatchObject({
      unreadCount: 0, lastReadMessageId: null, lastReadAt: 2001,
    });

    const restarted = new WebReadStateStore(path, 9000);
    const newMessages = [
      message(1, "user", 2100),
      message(2, "assistant", 2200),
    ];
    const afterRestart = await restarted.transaction((state) =>
      projectSessionReadState(state, "chat", newMessages),
    );
    expect(afterRestart).toMatchObject({
      unreadCount: 1, hasUnread: true,
      lastReadMessageId: null, lastReadAt: 2001,
    });

    const readAgain = await restarted.transaction((state) => {
      advanceReadCursor(
        state, "chat", newMessages, { readThroughMessageId: 2 }, 2001,
      );
      return projectSessionReadState(state, "chat", newMessages);
    });
    expect(readAgain).toMatchObject({
      unreadCount: 0, lastReadMessageId: "2", lastReadAt: 2002,
    });
    expect(JSON.parse(await readFile(path, "utf8")).initializedAt).toBe(1000);
  });

  test("deleting a conversation drops its cursor while preserving the migration boundary", async () => {
    const { store } = await fixture();
    await store.transaction((state) =>
      advanceReadCursor(
        state,
        "chat",
        messages,
        { readThroughMessageId: 4 },
        2000,
      ),
    );
    await store.forget("chat");
    expect(
      await store.transaction(
        (state) =>
          projectSessionReadState(state, "chat", [
            message(1, "assistant", 2100),
          ]).unreadCount,
      ),
    ).toBe(1);
  });

  test("corrupt persisted state surfaces an error instead of silently marking history read", async () => {
    const { path, store } = await fixture();
    await writeFile(path, '{"version":9}', "utf8");
    await expect(store.initialize()).rejects.toThrow(
      "Unsupported Web UI read state",
    );
    expect(await readFile(path, "utf8")).toBe('{"version":9}');
  });
});
