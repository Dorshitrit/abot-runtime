import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import { createSparkSessionClearBoundary } from "../session/spark-session-clear.js";
import { SessionRequestAdmission } from "../request/session-admission.js";
import { LocalRuntimeOwnerActivity } from "../local-host/owner-activity.js";
import { createLocalRuntimeMaintenance } from "../local-host/app-maintenance.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { RuntimeConfig } from "../ports.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationSnapshotStaging } from "../automations/snapshot-staging.js";
import * as snapshotStaging from "../automations/snapshot-staging.js";
import { listAutomationAttachmentOwners } from "../automations/attachment-owners.js";
import type { AutomationService } from "../automations/service.js";

const directories: string[] = [];
const releases: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(releases.splice(0).map(release => release()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function gate() {
  let open!: () => void;
  const waiting = new Promise<void>(resolve => { open = resolve; });
  return { open, waiting };
}
async function fixture() {
  const parent = resolve(".codex/artifacts/runtime-reset-spark-read-20261030/fixtures");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "sessions-")); directories.push(directory);
  const backing = createFileSessionStore({ sessionsDir: join(directory, "sessions") });
  const attachments = createFileAttachmentStore({ attachmentsDir: join(directory, "attachments") });
  let lifetime!: ReturnType<typeof createSessionLifecycleStore>;
  const admission = new SessionRequestAdmission(id => lifetime.isDeleted(id),
    async id => Boolean((await backing.requestLifecycle!.listWaiting(id)).length));
  lifetime = createSessionLifecycleStore(backing,
    result => attachments.deleteSessionAttachments(result.sessionId), undefined,
    createSparkSessionClearBoundary(backing, () => admission, attachments, directory));
  const sessions = lifetime.store;
  await sessions.getOrCreateSession("ordinary");
  await sessions.appendMessage("ordinary", "user", "history");
  await ensureSparkSession(sessions);
  const ordinaryAttachment = await attachments.saveAttachment({ sessionId: "ordinary", requestId: "upload",
    kind: "file", mimeType: "text/plain", bytes: Buffer.from("ordinary file") });
  const sparkAttachment = await attachments.saveAttachment({ sessionId: SPARK_SESSION_ID, requestId: "upload",
    kind: "file", mimeType: "text/plain", bytes: Buffer.from("SPARK file") });
  await sessions.appendMessage(SPARK_SESSION_ID, "user", "SPARK history", { attachments: [sparkAttachment] });
  const activity = new LocalRuntimeOwnerActivity();
  const verifyScope = vi.fn(async () => undefined);
  const config = { runtimeId: "dev", paths: { rootDir: directory, sessionsDir: join(directory, "sessions"),
    attachmentsDir: join(directory, "attachments"), traceFile: join(directory, "logs/trace.jsonl"), sharedDir: join(directory, "shared") } } as RuntimeConfig;
  const schedulerStore = createFileSchedulerStore(join(directory, "scheduler"));
  releases.push(await schedulerStore.acquire!());
  const persistence = createAutomationPersistence(schedulerStore);
  const automations = { listAttachmentOwners: () => listAutomationAttachmentOwners({ runtimeDir: directory, persistence }) } as AutomationService;
  const maintenance = createLocalRuntimeMaintenance({ services: { config, sessions, attachments, automations, requestAdmission: admission }, activity, verifyScope });
  return { directory, sessions, backing, lifetime, attachments, ordinaryAttachment, sparkAttachment, activity, admission, maintenance, verifyScope, persistence, automations };
}

test("reset uses canonical deletion, clears SPARK history and uploaded files, preserves its identity", async () => {
  const f = await fixture();
  const deletion = vi.fn(); f.lifetime.onDeleted(deletion);
  const ordinaryPath = (await f.attachments.resolveAttachment(f.ordinaryAttachment)).absolutePath;
  const sparkPath = (await f.attachments.resolveAttachment(f.sparkAttachment)).absolutePath;
  const draft = await f.attachments.saveAttachment({ sessionId: SPARK_SESSION_ID, requestId: "draft",
    kind: "file", mimeType: "text/plain", bytes: Buffer.from("unsent SPARK upload") });
  const draftPath = (await f.attachments.resolveAttachment(draft)).absolutePath;
  const result = await f.maintenance.resetSessions();
  expect(result).toEqual({ complete: true, deletedSessionIds: ["ordinary"], clearedSessionIds: [SPARK_SESSION_ID],
    failedSessionIds: [], deletedMessages: 2, deletedRequests: 0 });
  expect(deletion).toHaveBeenCalledWith("ordinary");
  expect(await f.sessions.getSessionById("ordinary")).toBeNull();
  expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toMatchObject({ kind: "spark", messages: [], contextEntries: [], requests: [] });
  await expect(readFile(ordinaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(sparkPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(draftPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.sessions.appendMessage("ordinary", "assistant", "late")).rejects.toThrow("deleted");
  await f.sessions.getOrCreateSession("fresh");
  expect(await f.admission.run("fresh", async () => "new request")).toBe("new request");
});

test.each(["request", "automation", "rpc", "approval"] as const)("%s blocks reset before any deletion", async kind => {
  const f = await fixture();
  const holding = gate();
  let running: Promise<unknown> | undefined;
  let release: (() => void) | null = null;
  if (kind === "request") running = f.admission.run("active", async () => holding.waiting);
  if (kind === "automation") release = f.admission.tryReserveAutomation("job");
  if (kind === "rpc") running = f.activity.run(async () => holding.waiting);
  if (kind === "approval") vi.spyOn(f.sessions.requestLifecycle!, "listWaiting").mockResolvedValue([{} as never]);
  try {
    await expect(f.maintenance.resetSessions()).rejects.toThrow(kind === "approval"
      ? "runtime_maintenance_pending_approvals" : "runtime_maintenance_busy");
    expect((await f.backing.getSessionById("ordinary"))?.messages).toHaveLength(1);
    expect((await f.backing.getSessionById(SPARK_SESSION_ID))?.messages).toHaveLength(1);
  } finally { release?.(); holding.open(); await running; }
});

test("maintenance fences peer calls, ordinary execution, scheduler and proactive delivery until complete", async () => {
  const f = await fixture(); const entered = gate(); const release = gate();
  f.verifyScope.mockImplementationOnce(async () => { entered.open(); await release.waiting; });
  const reset = f.maintenance.resetSessions();
  await entered.waiting;
  try {
    await expect(f.activity.run(async () => "peer write")).rejects.toThrow("runtime_maintenance_busy");
    const upload = vi.fn(() => f.attachments.saveAttachment({ sessionId: SPARK_SESSION_ID, requestId: "draft",
      kind: "file", mimeType: "text/plain", bytes: Buffer.from("racing upload") }));
    await expect(f.activity.run(upload)).rejects.toThrow("runtime_maintenance_busy");
    expect(upload).not.toHaveBeenCalled();
    await expect(f.maintenance.resetSessions()).rejects.toThrow("runtime_maintenance_busy");
    await expect(f.admission.run("ordinary", async () => "execute")).rejects.toThrow("runtime_maintenance_busy");
    await expect(f.admission.run(SPARK_SESSION_ID, async () => "deliver", true)).rejects.toThrow("runtime_maintenance_busy");
    expect(await f.admission.tryReserveAvailable("ordinary")).toBeNull();
    expect(f.admission.tryReserveAutomation("job")).toBeNull();
  } finally { release.open(); }
  expect((await reset).complete).toBe(true);
  expect(f.admission.isIdle()).toBe(true);
  expect(await f.activity.run(async () => "peer read")).toBe("peer read");
});

test("failed post-delete cleanup is reported and finished only by a later explicit reset", async () => {
  const f = await fixture();
  const cleanup = vi.fn().mockRejectedValueOnce(new Error("disk_failed")).mockResolvedValue(undefined);
  f.lifetime.onDeleted(cleanup);
  const first = await f.maintenance.resetSessions();
  expect(first.complete).toBe(false); expect(first.failedSessionIds).toEqual(["ordinary"]);
  expect(first.deletedSessionIds).toEqual([]); expect(cleanup).toHaveBeenCalledOnce();
  expect(await f.backing.getSessionById("ordinary")).toBeNull();
  const second = await f.maintenance.resetSessions();
  expect(second.complete).toBe(true); expect(second.deletedSessionIds).toEqual(["ordinary"]);
  expect(second.deletedMessages).toBe(1); expect(cleanup).toHaveBeenCalledTimes(2);
});

test("internal automation sessions remain excluded even when an injected store lists them", async () => {
  const f = await fixture();
  const original = f.sessions.getAllSessions.bind(f.sessions);
  vi.spyOn(f.sessions, "getAllSessions").mockImplementation(async () => [
    ...await original(), { id: "internal", automationOrigin: { kind: "automation_node_v1" } } as never,
  ]);
  const deleted = vi.spyOn(f.sessions, "deleteSessionWithStats");
  expect((await f.maintenance.resetSessions()).complete).toBe(true);
  expect(deleted).not.toHaveBeenCalledWith("internal");
});


test("reset deletes attachment-only conversation owners through canonical cleanup and preserves other environments", async () => {
  const f = await fixture(); const other = await fixture();
  const upload = { sessionId: "unsent", requestId: "upload", kind: "file" as const,
    mimeType: "text/plain", bytes: Buffer.from("unsent upload") };
  const attachment = await f.attachments.saveAttachment(upload);
  const otherAttachment = await other.attachments.saveAttachment(upload);
  const path = (await f.attachments.resolveAttachment(attachment)).absolutePath;
  const otherPath = (await other.attachments.resolveAttachment(otherAttachment)).absolutePath;
  expect(await f.sessions.getSessionById("unsent")).toBeNull();
  const deleted = vi.fn(); f.lifetime.onDeleted(deleted);
  const result = await f.maintenance.resetSessions();
  expect(result.complete).toBe(true);
  expect(result.deletedSessionIds).toContain("unsent");
  expect(deleted).toHaveBeenCalledWith("unsent");
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(otherPath, "utf8")).toBe("unsent upload");
  await expect(f.sessions.getOrCreateSession("unsent")).rejects.toThrow("deleted");
});

test("attachment inventory cannot expose a hidden automation owner to deletion or tombstoning", async () => {
  const f = await fixture();
  const handle = await f.sessions.createAutomationSession!("internal", {
    kind: "automation_node_v1", automationId: "automation", runId: "run", nodeId: "node", attemptId: "attempt",
  });
  const attachment = await f.attachments.saveAttachment({ sessionId: "internal", requestId: "upload",
    kind: "file", mimeType: "text/plain", bytes: Buffer.from("automation upload") });
  const path = (await f.attachments.resolveAttachment(attachment)).absolutePath;
  expect(await f.sessions.getSessionById("internal")).toBeNull();
  const deleted = vi.fn(); f.lifetime.onDeleted(deleted);
  expect((await f.maintenance.resetSessions()).complete).toBe(true);
  expect(deleted).not.toHaveBeenCalledWith("internal");
  expect(await readFile(path, "utf8")).toBe("automation upload");
  await expect(f.sessions.runAsAutomationSession!(handle, () => f.sessions.appendMessage("internal", "assistant", "still owned")))
    .resolves.toMatchObject({ id: "internal" });
  f.sessions.releaseAutomationSession!(handle);
});


test("attachment-only SPARK is cleared without tombstoning its permanent identity", async () => {
  const f = await fixture();
  await f.backing.deleteSessionWithStats(SPARK_SESSION_ID);
  const path = (await f.attachments.resolveAttachment(f.sparkAttachment)).absolutePath;
  const result = await f.maintenance.resetSessions();
  expect(result.clearedSessionIds).toContain(SPARK_SESSION_ID);
  expect(result.deletedSessionIds).not.toContain(SPARK_SESSION_ID);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(ensureSparkSession(f.sessions)).resolves.toMatchObject({ kind: "spark" });
});

test("attachment-only cleanup failure retains its target after the directory disappeared", async () => {
  const f = await fixture();
  await f.attachments.saveAttachment({ sessionId: "unsent", requestId: "upload", kind: "file", mimeType: "text/plain", bytes: Buffer.from("draft") });
  const remove = f.attachments.deleteSessionAttachments.bind(f.attachments); let failed = false;
  vi.spyOn(f.attachments, "deleteSessionAttachments").mockImplementation(async id => {
    await remove(id);
    if (id === "unsent" && !failed) { failed = true; throw new Error("post_cleanup_failure"); }
  });
  const first = await f.maintenance.resetSessions();
  expect(first.failedSessionIds).toEqual(["unsent"]);
  expect(first.deletedSessionIds).not.toContain("unsent");
  const second = await f.maintenance.resetSessions();
  expect(second.complete).toBe(true); expect(second.deletedSessionIds).toContain("unsent");
});

test.each(["attachment_inventory", "automation_inventory", "interactive_guard", "storage_error"])("%s fails before mutations", async capability => {
  const f = await fixture();
  await f.attachments.saveAttachment({ sessionId: "unsent", requestId: "upload", kind: "file", mimeType: "text/plain", bytes: Buffer.from("draft") });
  if (capability === "attachment_inventory") f.attachments.listSessionAttachmentOwners = undefined;
  if (capability === "automation_inventory") vi.spyOn(f.automations, "listAttachmentOwners").mockRejectedValue(new Error("inventory_failed"));
  if (capability === "interactive_guard") f.sessions.assertInteractiveSession = undefined;
  if (capability === "storage_error") vi.spyOn(f.sessions, "assertInteractiveSession").mockRejectedValue(new Error("record_unreadable"));
  await expect(f.maintenance.resetSessions()).rejects.toThrow();
  expect((await f.backing.getSessionById("ordinary"))?.messages).toHaveLength(1);
});

test("attachment inventory does not traverse owner symlinks or sibling environment roots", async () => {
  const f = await fixture(); const outside = join(f.directory, "unowned");
  expect(await createFileAttachmentStore({ attachmentsDir: join(f.directory, "missing") }).listSessionAttachmentOwners!()).toEqual([]);
  await mkdir(outside); await writeFile(join(outside, "keep.txt"), "preserved");
  await symlink(outside, join(f.directory, "attachments", "linked-owner"), "dir");
  expect(await f.attachments.listSessionAttachmentOwners!()).not.toContain("linked-owner");
  expect((await f.maintenance.resetSessions()).complete).toBe(true);
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("preserved");
});

test("automation execution, retained input and staged snapshot owners survive without session transcripts", async () => {
  const f = await fixture();
  const staged = createAutomationSnapshotStaging({ runtimeDir: f.directory, persistence: f.persistence, attachments: f.attachments });
  await staged.begin("prepared-run");
  const records = await Promise.all(["executed-run", "retained-input-owner", "prepared-run"].map(sessionId =>
    f.attachments.saveAttachment({ sessionId, requestId: "input", kind: "file", mimeType: "text/plain", bytes: Buffer.from(sessionId) })));
  await f.persistence.update(state => {
    state.executions.push({ id: "executed-run", automationId: "automation", definitionRevision: 1, revision: 1, inputIds: [], nodes: [] });
    state.inputs.push({ id: "input", automationId: "automation", sourceId: "source", canonicalPath: "/source/input.txt",
      contentVersion: "hash", observedAt: new Date().toISOString(), eligibility: "held",
      snapshot: { attachment: records[1]!, contentVersion: "hash", sizeBytes: records[1]!.size! } });
  });
  const result = await f.maintenance.resetSessions();
  expect(result.complete).toBe(true);
  for (const reference of records) {
    const owner = reference.storageRef.split("/")[0]!;
    expect(result.deletedSessionIds).not.toContain(owner);
    expect(await f.sessions.getSessionById(owner)).toBeNull();
    await expect(f.attachments.resolveAttachment(reference)).resolves.toMatchObject({ metadata: reference });
  }
});


test("candidate inventory precedes staging discovery and the post-marker committed journal read", async () => {
  const f = await fixture();
  const staged = createAutomationSnapshotStaging({ runtimeDir: f.directory, persistence: f.persistence, attachments: f.attachments });
  const save = (sessionId: string) => f.attachments.saveAttachment({ sessionId, requestId: "input", kind: "file",
    mimeType: "text/plain", bytes: Buffer.from(sessionId) });
  await staged.begin("racing-run"); const snapshot = await save("racing-run");
  const inventory = f.attachments.listSessionAttachmentOwners!.bind(f.attachments);
  let candidatesCaptured = false; let markersCaptured = false;
  vi.spyOn(f.attachments, "listSessionAttachmentOwners").mockImplementationOnce(async () => {
    const candidates = await inventory(); candidatesCaptured = true;
    await staged.begin("after-inventory"); await save("after-inventory");
    return candidates;
  });
  const readMarkers = snapshotStaging.readAutomationSnapshotPreparationOwners;
  vi.spyOn(snapshotStaging, "readAutomationSnapshotPreparationOwners").mockImplementationOnce(async runtimeDir => {
    expect(candidatesCaptured).toBe(true);
    // A preparation can publish and remove its marker while maintenance discovers owners.
    await f.persistence.update(state => { state.executions.push({ id: "racing-run", automationId: "automation",
      definitionRevision: 1, revision: 1, inputIds: [], nodes: [] }); });
    await rm(join(f.directory, "automation-snapshot-preparations", "racing-run.json"));
    const markers = await readMarkers(runtimeDir); markersCaptured = true;
    return markers;
  });
  const readJournal = f.persistence.read.bind(f.persistence);
  vi.spyOn(f.persistence, "read").mockImplementation(async () => {
    expect(markersCaptured).toBe(true);
    return readJournal();
  });
  const result = await f.maintenance.resetSessions();
  expect(result.complete).toBe(true);
  expect(result.deletedSessionIds).not.toContain("racing-run");
  expect(result.deletedSessionIds).not.toContain("after-inventory");
  await expect(f.attachments.resolveAttachment(snapshot)).resolves.toMatchObject({ metadata: snapshot });
  expect(await inventory()).toContain("after-inventory");
});

test("invalid automation preparation evidence rejects reset before deleting conversations", async () => {
  const f = await fixture();
  const staged = createAutomationSnapshotStaging({ runtimeDir: f.directory, persistence: f.persistence, attachments: f.attachments });
  await staged.begin("candidate");
  await writeFile(join(f.directory, "automation-snapshot-preparations", "candidate.json"), JSON.stringify({ kind: "unknown", runId: "candidate" }));
  await expect(f.maintenance.resetSessions()).rejects.toThrow("automation_snapshot_marker_invalid");
  expect((await f.backing.getSessionById("ordinary"))?.messages).toHaveLength(1);
});
