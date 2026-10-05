import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createAutomationSnapshotStaging } from "../automations/snapshot-staging.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "automation-snapshot-staging-"));
  roots.push(root);
  const attachments = createFileAttachmentStore({ attachmentsDir: join(root, "attachments") });
  const state = emptyAutomationJournalState();
  const persistence = { read: async () => structuredClone(state) } as AutomationPersistence;
  const options = { runtimeDir: root, persistence, attachments };
  const staged = createAutomationSnapshotStaging(options);
  const save = (runId: string) => attachments.saveAttachment({
    sessionId: runId, requestId: "input", kind: "file", mimeType: "text/plain",
    bytes: new TextEncoder().encode("frozen input"), name: "input.txt",
  });
  const markerPath = (runId: string) => join(root, "automation-snapshot-preparations", `${runId}.json`);
  return { root, attachments, state, options, staged, save, markerPath };
}

test("restart reclaims marked uncommitted snapshots and leaves ordinary attachment owners alone", async () => {
  const f = await fixture();
  await f.staged.begin("crashed-run");
  const snapshot = await f.save("crashed-run");
  const conversation = await f.save("ordinary-session");
  const recovered = createAutomationSnapshotStaging(f.options);
  await recovered.reconcile();
  await expect(f.attachments.resolveAttachment(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  const intact = await f.attachments.resolveAttachment(conversation);
  expect(await readFile(intact.absolutePath, "utf8")).toBe("frozen input");
  await expect(readFile(f.markerPath("crashed-run"))).rejects.toMatchObject({ code: "ENOENT" });
  await recovered.reconcile();
});

test("an active preparation is protected until its committed owner can be reconciled", async () => {
  const f = await fixture();
  await f.staged.begin("active-run");
  const snapshot = await f.save("active-run");
  await f.staged.reconcile();
  expect((await f.attachments.resolveAttachment(snapshot)).metadata).toMatchObject(snapshot);
  expect(JSON.parse(await readFile(f.markerPath("active-run"), "utf8"))).toMatchObject({ runId: "active-run" });
  f.state.executions.push({ id: "active-run", automationId: "automation", definitionRevision: 1,
    revision: 1, inputIds: [], nodes: [] });
  await f.staged.reconcile();
  expect((await f.attachments.resolveAttachment(snapshot)).metadata).toMatchObject(snapshot);
  await expect(readFile(f.markerPath("active-run"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("restart after the durable claim preserves the snapshot and removes only its staging marker", async () => {
  const f = await fixture();
  await f.staged.begin("claimed-run");
  const attachment = await f.save("claimed-run");
  f.state.inputs.push({ id: "input", automationId: "automation", sourceId: "source",
    canonicalPath: "/source/input.txt", contentVersion: "hash", observedAt: new Date().toISOString(),
    eligibility: "held", claimRunId: "claimed-run",
    snapshot: { attachment, contentVersion: "hash", sizeBytes: attachment.size! } });
  await createAutomationSnapshotStaging(f.options).reconcile();
  expect((await f.attachments.resolveAttachment(attachment)).metadata).toMatchObject(attachment);
  expect(await readdir(join(f.root, "automation-snapshot-preparations"))).toEqual([]);
});

test("failed orphan cleanup preserves its marker so a later maintenance pass retries it", async () => {
  const f = await fixture();
  await f.staged.begin("orphan-run");
  const snapshot = await f.save("orphan-run");
  const remove = vi.spyOn(f.attachments, "deleteSessionAttachments")
    .mockRejectedValueOnce(new Error("storage_busy"));
  const recovered = createAutomationSnapshotStaging(f.options);
  await expect(recovered.reconcile()).rejects.toThrow("storage_busy");
  expect(await readFile(f.markerPath("orphan-run"), "utf8")).toContain("orphan-run");
  await recovered.reconcile();
  expect(remove).toHaveBeenCalledTimes(2);
  await expect(f.attachments.resolveAttachment(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("restart can remove an interrupted marker write without claiming another owner's attachments", async () => {
  const f = await fixture();
  await f.staged.begin("active-run");
  const abandonedWrite = join(f.root, "automation-snapshot-preparations",
    "uncommitted-run.json.12345678-1234-1234-1234-123456789abc.tmp");
  await writeFile(abandonedWrite, '{"kind":');
  const ordinary = await f.save("uncommitted-run");
  await createAutomationSnapshotStaging(f.options).reconcile();
  await expect(readFile(abandonedWrite)).rejects.toMatchObject({ code: "ENOENT" });
  // No durable marker existed, so no attachment deletion is authorized for this owner.
  expect((await f.attachments.resolveAttachment(ordinary)).metadata).toMatchObject(ordinary);
});

test("a malformed staging record never authorizes deletion of another attachment owner", async () => {
  const f = await fixture();
  await f.staged.begin("candidate");
  const conversation = await f.save("ordinary-session");
  await writeFile(f.markerPath("candidate"), JSON.stringify({
    kind: "automation_snapshot_preparation_v1", runId: "ordinary-session",
  }));
  await expect(createAutomationSnapshotStaging(f.options).reconcile())
    .rejects.toThrow("automation_snapshot_marker_invalid");
  expect((await f.attachments.resolveAttachment(conversation)).metadata).toMatchObject(conversation);
});

test("discard after a published claim failure preserves committed snapshot bytes", async () => {
  const f = await fixture();
  await f.staged.begin("published-run");
  const snapshot = await f.save("published-run");
  f.state.executions.push({ id: "published-run", automationId: "automation", definitionRevision: 1,
    revision: 1, inputIds: [], nodes: [] });
  await f.staged.discard("published-run");
  expect((await f.attachments.resolveAttachment(snapshot)).metadata).toMatchObject(snapshot);
  await expect(readFile(f.markerPath("published-run"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("unreadable claim state preserves bytes and releases ownership for later reconciliation", async () => {
  const f = await fixture();
  await f.staged.begin("uncertain-run");
  const snapshot = await f.save("uncertain-run");
  const read = vi.spyOn(f.options.persistence, "read").mockRejectedValueOnce(new Error("journal_sync_failed"));
  await f.staged.discard("uncertain-run");
  expect((await f.attachments.resolveAttachment(snapshot)).metadata).toMatchObject(snapshot);
  expect(await readFile(f.markerPath("uncertain-run"), "utf8")).toContain("uncertain-run");
  read.mockRestore();
  await f.staged.reconcile();
  await expect(f.attachments.resolveAttachment(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("discard retains active protection until reconciliation releases a stale pre-claim snapshot", async () => {
  const f = await fixture();
  await f.staged.begin("racing-run");
  const snapshot = await f.save("racing-run");
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  let releaseRead!: () => void;
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  vi.spyOn(f.options.persistence, "read").mockImplementationOnce(async () => {
    const stale = structuredClone(f.state);
    readStarted();
    await gate;
    return stale;
  });
  const remove = vi.spyOn(f.attachments, "deleteSessionAttachments");
  const reconciliation = f.staged.reconcile();
  await started;
  f.state.executions.push({ id: "racing-run", automationId: "automation", definitionRevision: 1,
    revision: 1, inputIds: [], nodes: [] });
  const discard = f.staged.discard("racing-run");
  releaseRead();
  await Promise.all([reconciliation, discard]);
  expect(remove).not.toHaveBeenCalled();
  expect((await f.attachments.resolveAttachment(snapshot)).metadata).toMatchObject(snapshot);
});
