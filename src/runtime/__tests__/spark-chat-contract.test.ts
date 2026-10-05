import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import { resolveSparkChatRequest } from "../../web-ui/local-runtime/spark-chat-admission.js";
import { projectNotificationEvent } from "../../web-ui/notifications/event-projection.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES, normalizeLearningPreferences } from "../passive-learning/store.js";
import { readLearningPreferencesInput } from "../local-host/learning-preferences-input.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import type { RuntimeConfig } from "../ports.js";
import type { SessionSnapshotMessage } from "../../sessions/types.js";

function visibleObservations(messages: SessionSnapshotMessage[], ids: readonly (string | number)[]) {
  return messages.filter((message) => ids.includes(message.id)).map(({ id, createdAt, requestId }) => ({ id, createdAt, requestId }));
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-chat-contract-")); roots.push(root);
  let now = 1000;
  const byEnvironment = new Map<string, SessionService>();
  const environment = (id: string) => {
    const paths = { runtimeDir: join(root, id), sessionsDir: join(root, id, "sessions") };
    let sessions = byEnvironment.get(id);
    if (!sessions) { sessions = new SessionService({ sessionsDir: paths.sessionsDir, now: () => new Date(now) }); byEnvironment.set(id, sessions); }
    return { services: { sessions, config: { paths } as RuntimeConfig } };
  };
  const reads = new WebSessionReadStates(environment, () => now);
  return { root, reads, environment, setNow: (value: number) => { now = value; } };
}

describe("SPARK companion contract", () => {
  test("marks only visible assistant messages and shares receipts across clients and restart", async () => {
    const f = await fixture();
    const sessions = f.environment("dev").services.sessions;
    await Promise.all([ensureSparkSession(sessions), ensureSparkSession(sessions)]);
    for (let index = 0; index < 7; index++) {
      f.setNow(1100 + index); await sessions.appendMessage(SPARK_SESSION_ID, "assistant", `Message ${index}`);
    }
    const snapshot = (await sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
    const ids = snapshot.messages.map((message) => message.id);
    const initialRead = await f.reads.project("dev", snapshot);
    expect(initialRead).toMatchObject({ unreadMessageIds: ids, unreadCount: 7 });
    const generation = "readGeneration" in initialRead ? initialRead.readGeneration : "";
    const read = await f.reads.markVisible("dev", SPARK_SESSION_ID, [ids[0], ids[4]], generation, visibleObservations(snapshot.messages, [ids[0]!, ids[4]!]));
    expect(read).toMatchObject({ unreadMessageIds: [ids[1], ids[2], ids[3], ids[5], ids[6]], unreadCount: 5 });
    const restarted = new WebSessionReadStates(f.environment, () => 9999);
    expect(await restarted.project("dev", snapshot)).toMatchObject({ unreadCount: 5, readRevision: read?.readRevision });
    expect(await restarted.mark("dev", SPARK_SESSION_ID, { readThroughMessageId: ids[6] })).toMatchObject({ unreadCount: 5 });
    await ensureSparkSession(f.environment("prod").services.sessions);
    await f.environment("prod").services.sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Other environment");
    expect(await restarted.project("prod", (await f.environment("prod").services.sessions.getSessionSnapshot(SPARK_SESSION_ID))!)).toMatchObject({ unreadCount: 1 });
  });

  test("keeps the companion out of ordinary lists; reset preserves identity and resets receipts", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    await ensureSparkSession(sessions);
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Before clear");
    await sessions.appendMessage("legacy-proposal", "assistant", "Legacy suggestion");
    const original = (await sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
    const initial = await f.reads.project("dev", original);
    const generation = "readGeneration" in initial ? initial.readGeneration : "";
    await f.reads.markVisible("dev", SPARK_SESSION_ID, [1], generation, visibleObservations(original.messages, [1]));
    expect((await f.reads.list("dev")).sessions.map((session) => session.id)).toEqual(["legacy-proposal"]);
    await sessions.clearSessionMessages(SPARK_SESSION_ID); await f.reads.reset("dev", SPARK_SESSION_ID);
    const cleared = await ensureSparkSession(sessions);
    expect(cleared).toMatchObject({ id: SPARK_SESSION_ID, kind: "spark", messages: [] });
    f.setNow(1200); await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "New start");
    await expect(f.reads.markVisible("dev", SPARK_SESSION_ID, [1], generation, visibleObservations(original.messages, [1]))).rejects.toThrow("read_generation_changed");
    expect(await f.reads.project("dev", (await sessions.getSessionSnapshot(SPARK_SESSION_ID))!)).toMatchObject({ unreadCount: 1 });
    expect((await sessions.getSessionSnapshot("legacy-proposal"))?.messages).toHaveLength(1);
  });

  test("pre-clear receipts cannot mark reused IDs before the sidecar reset commits", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    await ensureSparkSession(sessions);
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Before", { requestId: "old-request" });
    const oldSnapshot = (await sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
    const read = await f.reads.project("dev", oldSnapshot);
    const generation = "readGeneration" in read ? read.readGeneration : "";
    await sessions.clearSessionMessages(SPARK_SESSION_ID);
    // Same millisecond and same numeric ID, while Web reset has not run yet.
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "After", { requestId: "new-request" });
    await expect(f.reads.markVisible("dev", SPARK_SESSION_ID, [1], generation,
      visibleObservations(oldSnapshot.messages, [1]))).rejects.toThrow("visible_message_receipt_stale");
    const current = (await sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
    expect(await f.reads.project("dev", current)).toMatchObject({ unreadCount: 1 });
    expect(await f.reads.markVisible("dev", SPARK_SESSION_ID, [1], generation,
      visibleObservations(current.messages, [1]))).toMatchObject({ unreadCount: 0 });
  });

  test("initiative read receipts survive a later ordinary reply with identical text", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    const content = "Would you like help with the next step?";
    await sessions.appendAssistantInitiative(SPARK_SESSION_ID, {
      title: "A possible next step", content,
      initiative: { kind: "proactive_proposal_v1", proposalId: "stable", reason: "A tentative interest",
        sources: [{ kind: "candidate", id: "interest", version: "1" }] },
    });
    const before = (await sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
    const initiative = before.messages[0]!;
    expect(initiative.requestId).toBeNull();
    const initialRead = await f.reads.project("dev", before);
    const generation = "readGeneration" in initialRead ? initialRead.readGeneration : "";
    const observed = visibleObservations(before.messages, [initiative.id]);
    await f.reads.markVisible("dev", SPARK_SESSION_ID, [initiative.id], generation, observed);

    f.setNow(2000);
    await sessions.startRequestStream(SPARK_SESSION_ID, "ordinary");
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", content, { requestId: "ordinary" });
    await sessions.appendRequestEvent(SPARK_SESSION_ID, "ordinary", { type: "completed", output: content });
    const refreshed = (await sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
    expect(refreshed.messages[0]).toEqual(initiative);
    expect(refreshed.messages[1]?.requestId).toBe("ordinary");
    expect(await f.reads.project("dev", refreshed)).toMatchObject({ unreadMessageIds: [1], unreadCount: 1 });
    const restarted = new WebSessionReadStates(f.environment, () => 3000);
    expect(await restarted.project("dev", refreshed)).toMatchObject({ unreadMessageIds: [1], unreadCount: 1 });
    expect(await restarted.markVisible("dev", SPARK_SESSION_ID, [initiative.id], generation, observed))
      .toMatchObject({ unreadMessageIds: [1], unreadCount: 1 });
  });

  test("ordinary legacy replies still infer request identity and explicit identities take precedence", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    await sessions.startRequestStream("ordinary", "latest");
    await sessions.appendMessage("ordinary", "assistant", "Same reply");
    await sessions.appendMessage("ordinary", "assistant", "Same reply", { requestId: "explicit" });
    await sessions.appendRequestEvent("ordinary", "latest", { type: "completed", output: "Same reply" });
    const snapshot = (await sessions.getSessionSnapshot("ordinary"))!;
    expect(snapshot.messages.map(({ requestId }) => requestId)).toEqual(["latest", "explicit"]);
  });

  test("persists ASK independently and accepts only explicit supported permission choices", async () => {
    const f = await fixture(); const store = createLearningStateStore(join(f.root, "learning"));
    expect((await store.read()).preferences.sparkToolPermissionMode).toBe("ask");
    for (const mode of ["ask", "full_access", "full_plus"] as const) {
      const input = readLearningPreferencesInput({ sparkToolPermissionMode: mode });
      const preferences = normalizeLearningPreferences(input, DEFAULT_LEARNING_PREFERENCES);
      await store.write({ schemaVersion: 1, preferences, batches: [] });
      expect((await store.read()).preferences.sparkToolPermissionMode).toBe(mode);
      expect(preferences.proactiveEnabled).toBe(false);
      expect(preferences.enabled).toBe(false);
    }
    for (const mode of [null, "full", "unknown", true])
      expect(() => readLearningPreferencesInput({ sparkToolPermissionMode: mode })).toThrow();
  });

  test("canonical SPARK model and permissions override stale client settings without altering ordinary requests", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    await ensureSparkSession(sessions);
    const preferences = { ...DEFAULT_LEARNING_PREFERENCES, modelProfileId: "learning", proactiveModelProfileId: "spark" };
    const environment = { services: { sessions, config: { models: { profiles: { spark: {} } } },
      passiveLearning: { status: vi.fn(async () => ({ preferences })) } } } as unknown as RuntimeEnvironment;
    const input = { text: "Help", modelPreference: { profileId: "ordinary" }, toolPermissionMode: "full_plus" };
    expect(await resolveSparkChatRequest(environment, SPARK_SESSION_ID, input)).toMatchObject({
      modelPreference: { profileId: "spark", scope: "all" }, toolPermissionMode: "ask",
    });
    expect(await resolveSparkChatRequest(environment, "ordinary", input)).toBe(input);
    expect(environment.services.passiveLearning.status).toHaveBeenCalledOnce();
    preferences.proactiveModelProfileId = "missing";
    await expect(resolveSparkChatRequest(environment, SPARK_SESSION_ID, input)).rejects.toThrow("spark_chat_model_unavailable");
  });

  test("notification destinations use the stored kind and exact assistant message", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    await ensureSparkSession(sessions);
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Result", { requestId: "r1" });
    const event = { type: "completed", environment: "dev", sessionId: SPARK_SESSION_ID, requestId: "r1", output: "Result" };
    const record = await sessions.getSessionById(SPARK_SESSION_ID);
    const source = projectNotificationEvent(event, 1000, record)?.sourceUrl;
    expect(source).toBe("/home?environment=dev&spark=1&message=1&messageCreatedAt=1000&request=r1");
    await sessions.clearSessionMessages(SPARK_SESSION_ID);
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "New result", { requestId: "r2" });
    const next = projectNotificationEvent({ ...event, requestId: "r2" }, 1000, await sessions.getSessionById(SPARK_SESSION_ID));
    expect(next?.sourceUrl).toBe("/home?environment=dev&spark=1&message=1&messageCreatedAt=1000&request=r2");
    expect(next?.sourceUrl).not.toBe(source);
    expect(projectNotificationEvent(event, 1000, { kind: undefined })?.sourceUrl).toBe("/chat?environment=dev&session=spark-companion");
  });
});
