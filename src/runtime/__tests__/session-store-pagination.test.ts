import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(adapter: string) {
  const root = await mkdtemp(join(tmpdir(), "session-store-pages-")); roots.push(root);
  const store = adapter === "file" ? createFileSessionStore({ sessionsDir: root }) : createInMemorySessionStore();
  for (let i = 1; i <= 7; i++) {
    await store.appendMessage("session", "assistant", `answer ${i}`, { requestId: `req-${i}` });
    await store.appendRequestEvent("session", `req-${i}`, { type: "completed", output: `answer ${i}` });
  }
  return store;
}

describe.each(["file", "memory"])("%s session store pagination contract", (adapter) => {
  test("bounds messages and events, navigates both ways, and preserves legacy reads", async () => {
    const store = await fixture(adapter);
    const latest = (await store.getSessionSnapshot("session", { page: { limit: 2 } }))!;
    expect(latest.messages.map((message) => message.requestId)).toEqual(["req-6", "req-7"]);
    expect(latest.requests.map((request) => request.requestId)).toEqual(["req-6", "req-7"]);
    const older = (await store.getSessionSnapshot("session", { page: { limit: 2, cursor: latest.nextCursor } }))!;
    expect(older.messages.map((message) => message.requestId)).toEqual(["req-4", "req-5"]);
    const newer = await store.getSessionSnapshot("session", { page: { limit: 2, cursor: older.newerCursor } });
    expect(newer?.messages).toEqual(latest.messages);
    expect((await store.getSessionSnapshot("session"))?.messages).toHaveLength(7);
    expect((await store.getSessionSnapshot("session", { includeRequests: false }))?.requests).toEqual([]);
    await store.clearSessionMessages("session");
    await expect(store.getSessionSnapshot("session", { page: { limit: 2, cursor: latest.nextCursor } })).rejects.toThrow("history_cursor_stale");
  });

  test("serves compact identities and target windows without exposing mutable history", async () => {
    const store = await fixture(adapter);
    const identities = (await store.getSessionSnapshot("session", { identitiesOnly: true }))!;
    expect(identities.messages).toEqual([]);
    expect(identities.requests).toEqual([]);
    expect(identities.messageIndex).toHaveLength(7);
    expect(identities.messageIndex?.[0]).not.toHaveProperty("text");
    const target = (await store.getSessionSnapshot("session", { page: { limit: 2, targetMessageId: String(identities.messageIndex![1]!.id) } }))!;
    expect(target.messages.map((message) => message.requestId)).toEqual(["req-2", "req-3"]);
    expect(target.newerCursor).toBeTruthy();
    target.messages[0]!.text = "mutated";
    target.requests[0]!.events.length = 0;
    const fresh = (await store.getSessionSnapshot("session", { page: { limit: 2, targetRequestId: "req-2" } }))!;
    expect(fresh.messages[0]!.text).toBe("answer 2");
    expect(fresh.requests[0]!.events).toHaveLength(1);
  });
});
