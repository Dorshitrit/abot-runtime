import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { withAutomationAgentSession } from "../automations/agent-session-lifetime.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import {
  createSchedulerRuntimeFixture, createSchedulerTestGate, SCHEDULED_ANSWER,
} from "./support/scheduler-runtime-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function sessionFixture() {
  const root = await mkdtemp(join(tmpdir(), "automation-session-lifetime-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const sessions = createFileSessionStore({ sessionsDir });
  const attachments = createFileAttachmentStore({ attachmentsDir: join(root, "attachments") });
  await sessions.appendMessage("ordinary", "user", "Keep this conversation");
  const origin = {
    kind: "automation_node_v1" as const, automationId: "automation", runId: "run",
    nodeId: "node", attemptId: "attempt",
  };
  return { sessions, attachments, sessionsDir, sessionId: "internal", origin };
}

test.each([false, true])("retires internal transcript and attachments after failure=%s", async (fails) => {
  const f = await sessionFixture();
  const saveAttachment = (sessionId: string) => f.attachments.saveAttachment({
    sessionId, requestId: "request", kind: "file", mimeType: "text/plain",
    bytes: new TextEncoder().encode("preserved input"),
  });
  const snapshot = await saveAttachment("run");
  const internalAttachment = await saveAttachment("internal");
  const failure = new Error("agent_failed");
  const result = withAutomationAgentSession(f, async (sessions) => {
    await sessions.appendMessage("internal", "assistant", "Internal transcript");
    expect(await sessions.getSessionById("internal")).not.toBeNull();
    if (fails) throw failure;
    return { text: "Canonical output" };
  });
  if (fails) await expect(result).rejects.toBe(failure);
  else await expect(result).resolves.toEqual({ text: "Canonical output" });
  expect((await readdir(f.sessionsDir)).filter((name) => name.endsWith(".json")))
    .toEqual(["ordinary.json"]);
  await expect(f.attachments.resolveAttachment(internalAttachment)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.attachments.resolveAttachment(snapshot)).resolves.toBeDefined();
  expect((await f.sessions.getSessionById("ordinary"))?.messages).toHaveLength(1);
});

test.each([false, true])("cleanup failure preserves the primary error when execution failed=%s", async (fails) => {
  const f = await sessionFixture();
  const cleanupFailure = new Error("cleanup_failed");
  const executionFailure = new Error("execution_failed");
  vi.spyOn(f.sessions, "deleteSessionWithStats").mockRejectedValue(cleanupFailure);
  await expect(withAutomationAgentSession(f, async () => {
    if (fails) throw executionFailure;
    return "output";
  })).rejects.toBe(fails ? executionFailure : cleanupFailure);
});

test("attempt retirement leaves no environment tombstones or deletion notifications", async () => {
  const f = await sessionFixture();
  const environment = createSessionLifecycleStore(f.sessions);
  const deleted = vi.fn();
  environment.onDeleted(deleted);
  for (const sessionId of ["attempt-1", "attempt-2", "attempt-3"]) {
    await withAutomationAgentSession({ ...f, sessionId }, async (sessions) => {
      await sessions.appendMessage(sessionId, "assistant", "Temporary output");
      await expect(environment.store.assertInteractiveSession!(sessionId))
        .rejects.toMatchObject({ code: "automation_session_locked" });
    });
    expect(environment.isDeleted(sessionId)).toBe(false);
    expect(await f.sessions.getSessionById(sessionId)).toBeNull();
  }
  expect(deleted).not.toHaveBeenCalled();
  await environment.store.deleteSession("ordinary");
  expect(environment.isDeleted("ordinary")).toBe(true);
  expect(deleted).toHaveBeenCalledExactlyOnceWith("ordinary");
});

test("a late captured attempt store cannot recreate its retired transcript", async () => {
  const f = await sessionFixture();
  const gate = createSchedulerTestGate();
  let lateWrite!: Promise<unknown>;
  await withAutomationAgentSession(f, async (sessions) => {
    await sessions.appendMessage("internal", "assistant", "Initial output");
    // Preserve the issued automation authority in the delayed continuation.
    lateWrite = gate.waiting.then(() =>
      sessions.appendMessage("internal", "assistant", "Late output"));
  });
  const rejected = expect(lateWrite).rejects.toMatchObject({ code: "session_deleted" });
  gate.open();
  await rejected;
  expect(await f.sessions.getSessionById("internal")).toBeNull();
  expect((await readdir(f.sessionsDir)).filter((name) => name.endsWith(".json")))
    .toEqual(["ordinary.json"]);
});

test("retiring another attempt does not close an active attempt's session", async () => {
  const f = await sessionFixture();
  const started = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  const first = withAutomationAgentSession({ ...f, sessionId: "first" }, async (sessions) => {
    await sessions.appendMessage("first", "user", "Begin");
    started.open();
    await resume.waiting;
    await sessions.appendMessage("first", "assistant", "Complete");
    expect((await sessions.getSessionById("first"))?.messages).toHaveLength(2);
  });
  await started.waiting;
  await withAutomationAgentSession({ ...f, sessionId: "second" }, async (sessions) => {
    await sessions.appendMessage("second", "assistant", "Independent output");
  });
  resume.open();
  await first;
  expect((await readdir(f.sessionsDir)).filter((name) => name.endsWith(".json")))
    .toEqual(["ordinary.json"]);
});

test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)(
  "%s saves readable run evidence while retiring internal transcripts", async (policy) => {
    const f = await createSchedulerRuntimeFixture(policy);
    cleanups.push(f.dispose);
    const schedulerDeletion = vi.spyOn(f.scheduler, "deleteSession");
    const environmentDeletion = vi.spyOn(f.application.services.sessions, "deleteSessionWithStats");
    const studio = f.application.services.automations!;
    let draft = await studio.create("Agent lifetime");
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
      nodeWithoutId: {
        kind: "agent", title: "Answer", onFailure: "stop", modelProfileId: "scheduled-model",
        agentMode: "reasoning", roleInstructions: "Answer briefly.", prompt: "Give a brief answer.",
        inputs: {}, tools: [], result: { kind: "text" },
      },
    });
    const nodeId = draft.definition.body.children[0]!.id;
    await studio.publish(draft.automationId, draft.revision);
    const started = await studio.runNow(draft.automationId);
    await vi.waitFor(async () => {
      expect((await studio.getRun(started.id)).status).toBe("succeeded");
    }, { timeout: 5000, interval: 10 });
    const evidence = await studio.getStepEvidence(started.id, nodeId, true);
    expect(evidence).toMatchObject({ availability: "available", stepStatus: "succeeded",
      output: { text: { value: SCHEDULED_ANSWER } } });
    expect((await studio.getRun(started.id)).report).not.toBeNull();
    expect((await readdir(f.config.paths.sessionsDir)).filter((name) => name.endsWith(".json")))
      .toEqual(["session.json"]);
    expect((await f.application.services.sessions.getSessionById("session"))?.messages).toHaveLength(2);
    expect(schedulerDeletion).not.toHaveBeenCalled();
    expect(environmentDeletion).not.toHaveBeenCalled();
    await f.application.services.sessions.deleteSession("session");
    expect(schedulerDeletion).toHaveBeenCalledExactlyOnceWith("session");
  },
);
