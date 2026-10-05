import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { ensureSparkSession } from "../../sessions/spark-session.js";
import { createSchedulerRuntimeFixture, createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { accepted, activationExpected } from "../../sessions/request-lifecycle/__tests__/support.js";
import { appendSparkInitiativeRecord, MAX_ASSISTANT_INITIATIVE_RECEIPTS } from "../../sessions/assistant-initiative-append.js";
import { MAX_PROACTIVE_RECEIPTS } from "../passive-learning/proactive/contracts.js";
import type { SessionRecord } from "../../sessions/types.js";
import { createSparkSessionClearBoundary } from "../session/spark-session-clear.js";
import { createFileSessionStore } from "../adapters/file-session-store.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  resetDebugLoggerConfig(); vi.restoreAllMocks();
});

test("active legacy requests cannot repopulate a successfully cleared SPARK conversation", async () => {
  const entered = createSchedulerTestGate(); const finish = createSchedulerTestGate();
  const fixture = await createSchedulerRuntimeFixture("supervisor-worker-v1", async () => {
    entered.open(); await finish.waiting;
  });
  fixtures.push(fixture);
  const spark = await ensureSparkSession(fixture.application.services.sessions);
  const run = fixture.application.requests.handle({ send() {} } as unknown as WebSocket, {
    type: "run_request", requestId: "active-companion", sessionId: spark.id,
    text: "Finish the current task", agentMode: "reasoning", toolPermissionMode: "ask",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
  try {
    await entered.waiting;
    await expect(fixture.application.services.sessions.clearSessionMessages(spark.id)).rejects.toThrow("spark_chat_busy");
    await expect(fixture.application.services.sessions.resetSession(spark.id)).rejects.toThrow("spark_chat_busy");
  } finally { finish.open(); await run; }
  const sessions = fixture.application.services.sessions;
  expect((await sessions.getSessionById(spark.id))?.messages).toHaveLength(2);
  await sessions.clearSessionMessages(spark.id);
  expect((await sessions.getSessionById(spark.id))?.messages).toEqual([]);
});

test("clearing SPARK preserves the durable proposal replay receipt", async () => {
  const fixture = await createSchedulerRuntimeFixture(); fixtures.push(fixture);
  const sessions = fixture.application.services.sessions;
  const spark = await ensureSparkSession(sessions);
  const proposal = { title: "An idea", content: "Would you like help?",
    initiative: { kind: "proactive_proposal_v1" as const, proposalId: "saved-before-receipt",
      reason: "A possible interest", sources: [{ kind: "candidate" as const, id: "one", version: "1" }] } };
  await sessions.appendAssistantInitiative!(spark.id, proposal);
  await sessions.clearSessionMessages(spark.id);
  await sessions.appendAssistantInitiative!(spark.id, proposal);
  expect((await sessions.getSessionById(spark.id))?.messages).toEqual([]);
});

test("a saved approval blocks clear even after its request is no longer running", async () => {
  const fixture = await createSchedulerRuntimeFixture(); fixtures.push(fixture);
  const sessions = fixture.application.services.sessions;
  const spark = await ensureSparkSession(sessions);
  const lifecycle = sessions.requestLifecycle!;
  const started = accepted(await lifecycle.startActivation(spark.id, {
    requestId: "parked", activationId: "activation", ownerEpoch: "owner",
  }));
  const continuation = await lifecycle.writeContinuation(spark.id, {
    schema: "test", version: 1, value: { prepared: true },
  });
  accepted(await lifecycle.commitWait(spark.id, {
    expected: activationExpected(started.current), waitId: "wait", continuation,
    approvals: [{ approvalId: "approval", actionFingerprint: "action", presentation: { tool: "fixture", summary: "Action" } }],
    presentationText: "Approve the prepared action.",
  }));
  const before = await sessions.getSessionById(spark.id);
  await expect(sessions.clearSessionMessages(spark.id)).rejects.toThrow("spark_chat_busy");
  expect(await sessions.getSessionById(spark.id)).toEqual(before);
  expect(await lifecycle.listWaiting(spark.id)).toHaveLength(1);
});

test("a request arriving during clear waits and sees only the newly empty conversation", async () => {
  const fixture = await createSchedulerRuntimeFixture(); fixtures.push(fixture);
  const sessions = fixture.application.services.sessions;
  const spark = await ensureSparkSession(sessions);
  await sessions.appendMessage(spark.id, "user", "Previous private topic");
  const entered = createSchedulerTestGate(); const finish = createSchedulerTestGate();
  const backing = createFileSessionStore({ sessionsDir: fixture.config.paths.sessionsDir });
  vi.spyOn(backing.requestLifecycle!, "listWaiting").mockImplementationOnce(async () => {
    entered.open(); await finish.waiting; return [];
  });
  const clearBoundary = createSparkSessionClearBoundary(backing, () => fixture.application.services.requestAdmission!);
  const clearing = clearBoundary(spark.id, () => backing.clearSessionMessages(spark.id));
  await entered.waiting;
  const running = fixture.application.requests.handle({ send() {} } as unknown as WebSocket, {
    type: "run_request", requestId: "after-clear", sessionId: spark.id, text: "A new topic",
    agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
  try {
    expect(fixture.invoke).not.toHaveBeenCalled();
  } finally { finish.open(); await clearing; await running; }
  expect(JSON.stringify(fixture.invoke.mock.calls)).not.toContain("Previous private topic");
  expect((await sessions.getSessionById(spark.id))?.messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
});

test("delivery dedup metadata covers the proactive receipt window and stays bounded after clear", () => {
  expect(MAX_ASSISTANT_INITIATIVE_RECEIPTS).toBeGreaterThanOrEqual(MAX_PROACTIVE_RECEIPTS);
  let session: SessionRecord | null = null;
  const now = new Date();
  for (let index = 0; index < MAX_PROACTIVE_RECEIPTS + 5; index++) {
    session = appendSparkInitiativeRecord(session, "spark-companion", {
      title: "Idea", content: "A new idea", initiative: { kind: "proactive_proposal_v1", proposalId: `proposal-${index}`,
        reason: "Interest", sources: [{ kind: "candidate", id: "one", version: "1" }] },
    }, now);
    session = { ...session, messages: [], messageCount: 0 };
  }
  expect(session!.assistantInitiativeReceipts).toHaveLength(MAX_ASSISTANT_INITIATIVE_RECEIPTS);
  expect(session!.assistantInitiativeReceipts?.at(-1)).toBe(`proposal-${MAX_PROACTIVE_RECEIPTS + 4}`);
});

test("clear removes captured transcript attachments and preserves a new upload during cleanup", async () => {
  const fixture = await createSchedulerRuntimeFixture(); fixtures.push(fixture);
  const { sessions, attachments, requestAdmission } = fixture.application.services;
  const spark = await ensureSparkSession(sessions);
  const old = await attachments.saveAttachment({ sessionId: spark.id, requestId: "old-upload", kind: "file",
    mimeType: "text/plain", bytes: Buffer.from("old content") });
  await sessions.appendMessage(spark.id, "user", "Read this", { attachments: [old] });
  const entered = createSchedulerTestGate(); const finish = createSchedulerTestGate();
  const remove = attachments.deleteAttachment!.bind(attachments);
  vi.spyOn(attachments, "deleteAttachment").mockImplementationOnce(async (...args) => {
    entered.open(); await finish.waiting; return remove(...args);
  });
  const clearing = sessions.clearSessionMessages(spark.id);
  await entered.waiting;
  try {
    expect(requestAdmission!.tryReserve(spark.id)).toBeNull();
    const fresh = await attachments.saveAttachment({ sessionId: spark.id, requestId: "new-upload", kind: "file",
      mimeType: "text/plain", bytes: Buffer.from("new content") });
    finish.open(); await clearing;
    await expect(attachments.validateAttachmentReferences([fresh], { sessionId: spark.id })).resolves.toHaveLength(1);
    await expect(attachments.validateAttachmentReferences([old], { sessionId: spark.id })).rejects.toThrow();
  } finally { finish.open(); await clearing; }
});

test("attachment cleanup failure cannot report a successful clear and releases admission", async () => {
  const fixture = await createSchedulerRuntimeFixture(); fixtures.push(fixture);
  const { sessions, attachments, requestAdmission } = fixture.application.services;
  const spark = await ensureSparkSession(sessions);
  const old = await attachments.saveAttachment({ sessionId: spark.id, requestId: "upload", kind: "file",
    mimeType: "text/plain", bytes: Buffer.from("content") });
  await sessions.appendMessage(spark.id, "user", "Read this", { attachments: [old] });
  vi.spyOn(attachments, "deleteAttachment").mockRejectedValueOnce(new Error("attachment_cleanup_failed"));
  await expect(sessions.clearSessionMessages(spark.id)).rejects.toThrow("attachment_cleanup_failed");
  const release = requestAdmission!.tryReserve(spark.id);
  expect(release).toBeTypeOf("function"); release!();
});
