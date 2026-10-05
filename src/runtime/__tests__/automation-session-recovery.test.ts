import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import { withAutomationAgentSession } from "../automations/agent-session-lifetime.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";
import * as durable from "../../sessions/durable-session-commit.js";
import { SessionService } from "../../sessions/session-service.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const origin = { kind: "automation_node_v1" as const, automationId: "automation", runId: "run",
  nodeId: "node", attemptId: "attempt" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "automation-session-recovery-"));
  roots.push(root);
  const sessionsDir = join(root, "sessions");
  const sessions = createFileSessionStore({ sessionsDir });
  const attachments = createFileAttachmentStore({ attachmentsDir: join(root, "attachments") });
  const results = createAutomationResultStore(root);
  const cleanup = vi.fn((id: string) => attachments.deleteSessionAttachments(id));
  const failure = vi.fn();
  const saveAttachment = (sessionId: string) => attachments.saveAttachment({ sessionId,
    requestId: "request", kind: "file", mimeType: "text/plain", bytes: new TextEncoder().encode("Kept bytes") });
  return { root, sessionsDir, sessions, attachments, results, cleanup, failure, saveAttachment,
    sessionId: "internal", origin,
    reopen: () => createFileSessionStore({ sessionsDir }),
    raw: (id: string) => readFile(join(sessionsDir, `${id}.json`), "utf8") };
}

test("restart removes only valid automation-origin transcripts and their attempt attachments", async () => {
  const f = await fixture();
  await f.sessions.appendMessage("ordinary", "user", "Keep this conversation");
  await f.sessions.createAutomationSession!("orphan", origin);
  const ordinary = await f.saveAttachment("ordinary");
  const orphan = await f.saveAttachment("orphan");
  const frozenInput = await f.saveAttachment("run");
  const report = await f.results.save({ runId: "run", kind: "report", value: { outcome: "succeeded" }, maxBytes: 1000 });
  const invalid = { id: "invalid", automationOrigin: { kind: "automation_node_v1" }, messages: [] };
  await writeFile(join(f.sessionsDir, "invalid.json"), JSON.stringify(invalid));
  await writeFile(join(f.sessionsDir, "mismatch.json"), JSON.stringify({ ...invalid, id: "ordinary", automationOrigin: origin }));
  await symlink(join(f.sessionsDir, "ordinary.json"), join(f.sessionsDir, "linked.json"));
  const recovered = f.reopen();
  expect((await recovered.getAllSessions()).some((record) => record.id === "orphan")).toBe(false);
  await recovered.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("orphan");
  await expect(f.raw("orphan")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.attachments.resolveAttachment(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.attachments.resolveAttachment(ordinary)).resolves.toBeDefined();
  await expect(f.attachments.resolveAttachment(frozenInput)).resolves.toBeDefined();
  await expect(f.results.read(report)).resolves.toEqual({ outcome: "succeeded" });
  expect((await recovered.getSessionById("ordinary"))?.messages[0]?.content).toBe("Keep this conversation");
  expect(await readdir(f.sessionsDir)).toEqual(expect.arrayContaining(["ordinary.json", "invalid.json", "mismatch.json", "linked.json"]));
});

test("issued handles protect both the create-to-run gap and active execution across reconciliation", async () => {
  const f = await fixture();
  const handle = await f.sessions.createAutomationSession!("internal", origin);
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).not.toHaveBeenCalled();
  await f.sessions.runAsAutomationSession!(handle, async () => {
    await f.sessions.appendMessage("internal", "assistant", "Active");
    await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
    expect(await f.sessions.getSessionById("internal")).not.toBeNull();
  });
  f.sessions.releaseAutomationSession!(handle);
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("internal");
  await expect(f.sessions.runAsAutomationSession!(handle, async () => undefined)).rejects.toThrow("automation_session_locked");
});

test("create reserves ownership before durable storage awaits and releases it on uncertain create failure", async () => {
  const f = await fixture();
  const saved = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  const save = durable.saveDurableSessionFile;
  vi.spyOn(durable, "saveDurableSessionFile").mockImplementationOnce(async (...args) => {
    await save(...args); saved.open(); await resume.waiting;
    throw new Error("create_commit_uncertain");
  });
  const creating = f.sessions.createAutomationSession!("internal", origin);
  await saved.waiting;
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).not.toHaveBeenCalled();
  resume.open();
  await expect(creating).rejects.toThrow("create_commit_uncertain");
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("internal");
});

test.each([false, true])("attachment cleanup failure retains durable origin and primary outcome, failed=%s", async (failed) => {
  const f = await fixture();
  const attachment = await f.saveAttachment("internal");
  const failure = new Error("attachment_cleanup_failed");
  const execution = new Error("execution_failed");
  const remove = vi.spyOn(f.attachments, "deleteSessionAttachments").mockRejectedValueOnce(failure);
  await expect(withAutomationAgentSession(f, async () => {
    if (failed) throw execution;
    return "output";
  })).rejects.toBe(failed ? execution : failure);
  expect(JSON.parse(await f.raw("internal")).automationOrigin).toEqual(origin);
  await expect(f.attachments.resolveAttachment(attachment)).resolves.toBeDefined();
  // Released ownership allows recovery without requiring another process.
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(remove).toHaveBeenCalledTimes(2);
  await expect(f.raw("internal")).rejects.toMatchObject({ code: "ENOENT" });
});

test("attempt tombstone blocks late writes before attachment cleanup begins awaiting", async () => {
  const f = await fixture();
  const started = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  const late = createSchedulerTestGate();
  let lateWrite!: Promise<unknown>;
  vi.spyOn(f.attachments, "deleteSessionAttachments").mockImplementationOnce(async () => {
    started.open(); await resume.waiting; throw new Error("cleanup_failed");
  });
  const running = withAutomationAgentSession(f, async (sessions) => {
    lateWrite = late.waiting.then(() => sessions.appendMessage("internal", "assistant", "Too late"));
  });
  await started.waiting;
  const rejected = expect(lateWrite).rejects.toMatchObject({ code: "session_deleted" });
  late.open(); await rejected;
  expect(JSON.parse(await f.raw("internal")).messages).toEqual([]);
  resume.open(); await expect(running).rejects.toThrow("cleanup_failed");
});

test("class-based injected adapters retain prototype methods and their original receiver", async () => {
  const f = await fixture();
  const sessions = new SessionService({ sessionsDir: f.sessionsDir });
  await expect(withAutomationAgentSession({ ...f, sessions }, async (attempt) => {
    await attempt.appendMessage("internal", "assistant", "Class adapter output");
    expect((await attempt.getSessionById("internal"))?.messages[0]?.content)
      .toBe("Class adapter output");
    return "complete";
  })).resolves.toBe("complete");
  await expect(f.raw("internal")).rejects.toMatchObject({ code: "ENOENT" });
});

test("failed transcript deletion leaves discoverable origin and releases the active handle", async () => {
  const f = await fixture();
  vi.spyOn(f.sessions, "deleteSessionWithStats").mockRejectedValueOnce(new Error("transcript_busy"));
  await expect(withAutomationAgentSession(f, async () => "done")).rejects.toThrow("transcript_busy");
  expect(JSON.parse(await f.raw("internal")).automationOrigin).toEqual(origin);
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("internal");
  await expect(f.raw("internal")).rejects.toMatchObject({ code: "ENOENT" });
});

test("recovery claim blocks same-ID creation until exact-origin cleanup completes", async () => {
  const f = await fixture();
  await f.sessions.createAutomationSession!("internal", origin);
  const recovered = f.reopen();
  const started = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  const reconcile = recovered.reconcileAutomationSessions!(async () => { started.open(); await resume.waiting; }, f.failure);
  await started.waiting;
  await expect(recovered.createAutomationSession!("internal", origin)).rejects.toThrow("automation_session_locked");
  resume.open(); await reconcile;
  expect(f.failure).not.toHaveBeenCalled();
});

test("a rejected different-origin create does not release another attempt's active ownership", async () => {
  const f = await fixture();
  const handle = await f.sessions.createAutomationSession!("internal", origin);
  await expect(f.sessions.createAutomationSession!("internal", { ...origin, attemptId: "other" }))
    .rejects.toThrow("automation_session_locked");
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).not.toHaveBeenCalled();
  f.sessions.releaseAutomationSession!(handle);
  await f.sessions.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).toHaveBeenCalledOnce();
});

test("failed candidates do not starve later bounded retirement batches", async () => {
  const f = await fixture();
  for (let index = 0; index < 66; index++)
    await f.sessions.createAutomationSession!(`orphan-${String(index).padStart(2, "0")}`, origin);
  const recovered = f.reopen();
  const cleaned: string[] = [];
  const cleanup = async (id: string) => {
    if (id !== "orphan-65") throw new Error("unavailable");
    cleaned.push(id);
  };
  await recovered.reconcileAutomationSessions!(cleanup, f.failure);
  expect(f.failure).toHaveBeenCalledTimes(64);
  expect(cleaned).toEqual([]);
  await recovered.reconcileAutomationSessions!(cleanup, f.failure);
  expect(cleaned).toEqual(["orphan-65"]);
  await expect(f.raw("orphan-00")).resolves.toBeDefined();
});

test("bounded scanning advances past an ordinary-heavy prefix without modifying it", async () => {
  const f = await fixture();
  await f.sessions.createAutomationSession!("z-orphan", origin);
  await Promise.all(Array.from({ length: 260 }, (_, index) => {
    const id = `ordinary-${String(index).padStart(3, "0")}`;
    return writeFile(join(f.sessionsDir, `${id}.json`), JSON.stringify({ id, messages: [] }));
  }));
  const recovered = f.reopen();
  await recovered.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).not.toHaveBeenCalled();
  await recovered.reconcileAutomationSessions!(f.cleanup, f.failure);
  expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("z-orphan");
  expect((await readdir(f.sessionsDir)).filter((name) => name.startsWith("ordinary-"))).toHaveLength(260);
});
