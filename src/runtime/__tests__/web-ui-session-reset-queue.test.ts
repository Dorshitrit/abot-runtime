import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WebClientStateStore } from "../../web-ui/client-state/store.js";
import { createRuntimeSessionResetClientState } from "../../web-ui/client-state/session-reset.js";
import { changeClientQueue } from "../../web-ui/client-state/queue.js";
import type { RuntimeSessionsResetResult } from "../local-host/maintenance-contracts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const success: RuntimeSessionsResetResult = { complete: true, deletedSessionIds: ["deleted"],
  clearedSessionIds: ["spark-companion"], failedSessionIds: [], deletedMessages: 2, deletedRequests: 1 };
async function fixture() {
  const directory = join(process.cwd(), ".codex/artifacts/runtime-reset-spark-read-20261030");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, "queue-test-")); roots.push(root);
  const store = new WebClientStateStore(root);
  await store.transaction(state => {
    for (const [environmentId, sessionId] of [["dev", "deleted"], ["dev", "spark-companion"], ["dev", "orphan"], ["prod", "deleted"]]) {
      changeClientQueue(state, { action: "enqueue", scope: { environmentId, sessionId },
        item: { waitForRequestId: "request", text: "queued", attachments: [], agentMode: "reasoning", toolPermissionMode: "ask" } });
    }
  });
  return { store, reset: createRuntimeSessionResetClientState(root) };
}
async function scopes(store: WebClientStateStore) {
  const { state } = await store.transaction(() => null);
  return JSON.parse(state.queue).queues.map((entry: { environmentId: string; sessionId: string }) => [entry.environmentId, entry.sessionId]);
}
test("complete reset removes only the selected environment's queues, including old orphan records", async () => {
  const f = await fixture();
  expect(await f.reset("dev", async () => success)).toEqual(success);
  expect(await scopes(f.store)).toEqual([["prod", "deleted"]]);
});
test("partial reset preserves failed and untouched queue targets", async () => {
  const f = await fixture();
  await f.reset("dev", async () => ({ ...success, complete: false, clearedSessionIds: [], failedSessionIds: ["spark-companion"] }));
  expect(await scopes(f.store)).toEqual([["dev", "spark-companion"], ["dev", "orphan"], ["prod", "deleted"]]);
});
test("rejected reset preserves queue bytes and revision", async () => {
  const f = await fixture(); const before = await f.store.transaction(() => null);
  await expect(f.reset("dev", async () => { throw new Error("runtime_maintenance_busy"); })).rejects.toThrow("runtime_maintenance_busy");
  expect((await f.store.transaction(() => null)).state).toEqual(before.state);
});
test("concurrent queue mutations cannot pass the reset's owner operation", async () => {
  const f = await fixture(); let finish!: () => void; let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const resetting = f.reset("dev", async () => { entered(); await gate; return success; });
  await inside;
  const later = vi.fn(); const queued = f.store.transaction(later);
  await Promise.resolve(); expect(later).not.toHaveBeenCalled();
  finish(); await resetting; await queued;
  expect(later).toHaveBeenCalledOnce(); expect(await scopes(f.store)).toEqual([["prod", "deleted"]]);
});
