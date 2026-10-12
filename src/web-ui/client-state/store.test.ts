import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebClientStateStore } from "./store.js";
import { updatePreference } from "./preferences.js";
import { changeClientQueue } from "./queue.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abot-client-state-"));
  roots.push(root);
  return { root, store: new WebClientStateStore(root) };
}
const scope = { environmentId: "prod", sessionId: "conversation" };
const item = { waitForRequestId: "first", text: "Next instruction", attachments: [], agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: null };

describe("installation-owned Web UI state", () => {
  test("starts in Ask and keeps preferences independently of a store instance", async () => {
    const { root, store } = await fixture();
    const fresh = await store.transaction(() => null);
    expect(fresh.state.preferences["abot-web.lastToolPermissionMode"]).toBe("ask");
    expect(fresh.state.introductionSeen).toBe(false);
    await store.transaction((state) => {
      state.introductionSeen = true;
      updatePreference(state.preferences, { key: "abot-web.lastToolPermissionMode", before: "ask", value: "full_access" });
    });
    const reopened = await new WebClientStateStore(root).transaction(() => null);
    expect(reopened.state.introductionSeen).toBe(true);
    expect(reopened.state.preferences["abot-web.lastToolPermissionMode"]).toBe("full_access");
  });

  test("merges independent conversation changes from two writers and rejects conflicting changes", async () => {
    const { root, store } = await fixture();
    const other = new WebClientStateStore(root);
    const key = "abot-web.sessionModels";
    await Promise.all([
      store.transaction((state) => updatePreference(state.preferences, { key, before: null, value: JSON.stringify({ first: "model-a" }) })),
      other.transaction((state) => updatePreference(state.preferences, { key, before: null, value: JSON.stringify({ second: "model-b" }) })),
    ]);
    const saved = (await store.transaction(() => null)).state;
    expect(JSON.parse(saved.preferences[key])).toEqual({ first: "model-a", second: "model-b" });
    await expect(other.transaction((state) => updatePreference(state.preferences, {
      key, before: JSON.stringify({ first: "old" }), value: JSON.stringify({ first: "replacement" }),
    }))).rejects.toMatchObject({ code: "preferences_changed" });
    expect((await store.transaction(() => null)).state).toEqual(saved);
  });

  // Exercise real lock and fsync I/O without making 32 writes a 5-second benchmark.
  test("keeps concurrent refreshes and preference writes complete across store instances", async () => {
    const { root, store } = await fixture();
    const other = new WebClientStateStore(root);
    await Promise.all([store, other].map((writer) => writer.transaction(() => null)));
    const expected: Record<string, string> = {};
    for (let batch = 0; batch < 4; batch++) {
      const operations = Array.from({ length: 8 }, (_, index) => {
        const session = `conversation-${batch}-${index}`;
        expected[session] = "model";
        return [
          store.transaction((state) => updatePreference(state.preferences, {
            key: "abot-web.sessionModels", before: null, value: JSON.stringify({ [session]: "model" }),
          })),
          other.transaction(() => null),
        ];
      }).flat();
      const outcomes = await Promise.allSettled(operations);
      expect(outcomes.filter((result) => result.status === "rejected")).toEqual([]);
    }
    const saved = (await store.transaction(() => null)).state;
    expect(saved.revision).toBe(32);
    expect(JSON.parse(saved.preferences["abot-web.sessionModels"])).toEqual(expected);
  }, 30_000);

  test("only one window can release an item; a restart does not release it again", async () => {
    const { root, store } = await fixture();
    await store.transaction((state) => changeClientQueue(state, { action: "enqueue", scope, item }));
    const releases = await Promise.all([store, new WebClientStateStore(root)].map((writer) =>
      writer.transaction((state) => changeClientQueue(state, { action: "release", scope, requestId: "first" }))));
    expect(releases.filter(({ result }) => result !== null)).toHaveLength(1);
    const restarted = new WebClientStateStore(root);
    const release = await restarted.transaction((state) => changeClientQueue(state, { action: "release", scope, requestId: "first" }));
    expect(release.result).toBeNull();
    const blocked = JSON.parse(release.state.queue).queues[0];
    expect(blocked.blockedReleaseItem).toEqual(item);
    // A stale snapshot of the preceding request must not clear another window's claim.
    expect((await restarted.transaction((state) => changeClientQueue(state, {
      action: "rebind", scope, requestId: "first",
    }))).result).toBe(false);
    expect((await restarted.transaction((state) => changeClientQueue(state, {
      action: "release", scope, requestId: "first",
    }))).result).toBeNull();
  });

  test("persists and releases queues with long configured environment identifiers", async () => {
    const { root, store } = await fixture();
    const longScope = { ...scope, environmentId: "environment-".repeat(40) };
    await store.transaction((state) => changeClientQueue(state, { action: "enqueue", scope: longScope, item }));
    const restarted = new WebClientStateStore(root);
    const released = await restarted.transaction((state) => changeClientQueue(state, { action: "release", scope: longScope, requestId: "first" }));
    expect(released.result).toMatchObject({ item });
    expect(JSON.parse(released.state.queue).queues[0].environmentId).toBe(longScope.environmentId);
    expect((await restarted.transaction((state) => changeClientQueue(state, { action: "release", scope, requestId: "first" }))).result).toBeNull();
  });

  test("still bounds the whole queue state for oversized identifiers", async () => {
    const { store } = await fixture();
    await expect(store.transaction((state) => changeClientQueue(state, {
      action: "enqueue", scope: { ...scope, environmentId: "e".repeat(8 * 1024 * 1024) }, item,
    }))).rejects.toMatchObject({ code: "workspace_storage_full" });
    expect((await store.transaction(() => null)).state.revision).toBe(0);
  });

  test("isolates queue scopes and does not acknowledge an incorrect release token", async () => {
    const { store } = await fixture();
    await store.transaction((state) => changeClientQueue(state, { action: "enqueue", scope, item }));
    expect((await store.transaction((state) => changeClientQueue(state, {
      action: "release", scope: { ...scope, environmentId: "dev" }, requestId: "first",
    }))).result).toBeNull();
    await store.transaction((state) => changeClientQueue(state, { action: "release", scope, requestId: "first" }));
    expect((await store.transaction((state) => changeClientQueue(state, {
      action: "bind", scope, requestId: "next", releaseToken: "wrong",
    }))).result).toBe(false);
  });

  test("preserves a corrupt file and reports it instead of starting empty", async () => {
    const { store } = await fixture();
    await store.transaction((state) => { state.introductionSeen = true; });
    await writeFile(store.path, "broken state");
    await expect(store.transaction(() => null)).rejects.toThrow();
    expect(await readFile(store.path, "utf8")).toBe("broken state");
  });

  test("an explicit reload can initialize the store after a directory obstruction is repaired", async () => {
    const { store } = await fixture();
    await mkdir(dirname(store.directory), { recursive: true });
    await writeFile(store.directory, "obstruction");
    await expect(store.transaction(() => null)).rejects.toThrow();
    expect(await readFile(store.directory, "utf8")).toBe("obstruction");
    await rm(store.directory);
    expect((await store.transaction(() => null)).state.preferences["abot-web.lastToolPermissionMode"]).toBe("ask");
  });

  test("rejects unknown preferences, invalid permission choices and unbounded receipts", async () => {
    const { store } = await fixture();
    for (const input of [
      { key: "password", before: null, value: "secret" },
      { key: "abot-web.lastToolPermissionMode", before: "ask", value: "invalid" },
      { key: "abot-web.homeGuidance.prod", before: null, value: JSON.stringify({ reviewed: Array(201).fill({ id: "a", updatedAt: "today" }) }) },
      { key: "abot-web.sessionModels", before: null, value: '{"__proto__":{"polluted":true}}' },
      { key: "abot-web.sessionModes", before: null, value: '{"chat":{"toolPermissionMode":"unknown","savedAt":1}}' },
      { key: "abot-web.sessionModels", before: null, value: '{"chat":{"unexpected":"data"}}' },
      { key: "abot.spark.launcher.position.v1", before: null, value: '{"x":"bad","y":0}' },
      { key: "abot-web.homeGuidance.prod", before: null, value: '{"reviewed":[{"id":"a","updatedAt":"v1","content":"private"}]}' },
    ]) {
      await expect(store.transaction((state) => updatePreference(state.preferences, input))).rejects.toThrow();
    }
    expect((await store.transaction(() => null)).state.revision).toBe(0);
  });
});
