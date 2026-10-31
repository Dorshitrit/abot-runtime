import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebReadStateStore } from "../../web-ui/session-read-state/store.js";
import { resetConversationReadStates } from "../../web-ui/session-read-state/reset.js";
import type { RuntimeSessionsResetResult } from "../local-host/maintenance-contracts.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function gate() {
  let open!: () => void;
  const waiting = new Promise<void>(resolve => { open = resolve; });
  return { open, waiting };
}
async function fixture() {
  const parent = resolve(".codex/artifacts/runtime-reset-spark-read-20261030/fixtures");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "read-reset-")); directories.push(directory);
  const path = join(directory, "read-state.json");
  const store = new WebReadStateStore(path, 1);
  await store.transaction(state => {
    state.cursors = [["removed", { messageId: "old", createdAt: 1, lastReadAt: 1 }],
      ["failed", { messageId: "preserved", createdAt: 2, lastReadAt: 2 }]];
    state.visibleMessages = [["spark-companion", { generation: "before", revision: 2, messages: [] }]];
  });
  const result: RuntimeSessionsResetResult = { complete: false, deletedSessionIds: ["removed"],
    clearedSessionIds: ["spark-companion"], failedSessionIds: ["failed"], deletedMessages: 2, deletedRequests: 0 };
  return { store, peer: new WebReadStateStore(path, 1), result };
}

test("owner reset and read reconciliation exclude concurrent receipt writes across store instances", async () => {
  const f = await fixture(); const entered = gate(); const release = gate();
  const reset = resetConversationReadStates(f.store, async () => { entered.open(); await release.waiting; return f.result; }, () => 10);
  await entered.waiting;
  let observed = false;
  const read = f.peer.transaction(state => {
    observed = true;
    const spark = new Map(state.visibleMessages).get("spark-companion")!;
    expect(spark.generation).not.toBe("before");
    spark.revision = 11;
    expect(state.cursors.map(([id]) => id)).toEqual(["failed", "spark-companion"]);
  });
  await Promise.resolve(); expect(observed).toBe(false);
  release.open(); await reset; await read;
  const persisted = await f.store.transaction(state => state);
  expect(new Map(persisted.visibleMessages).get("spark-companion")?.revision).toBe(11);
  expect(new Map(persisted.cursors).get("failed")?.messageId).toBe("preserved");
});

test("owner rejection preserves existing receipts and releases the read-state lock", async () => {
  const f = await fixture();
  await expect(resetConversationReadStates(f.store, async () => { throw new Error("runtime_maintenance_busy"); }, () => 10))
    .rejects.toThrow("runtime_maintenance_busy");
  const persisted = await f.peer.transaction(state => state);
  expect(new Map(persisted.visibleMessages).get("spark-companion")?.generation).toBe("before");
  expect(new Map(persisted.cursors).has("removed")).toBe(true);
});
