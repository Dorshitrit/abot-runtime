import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import { SessionService } from "../../sessions/session-service.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { WebNotification } from "../../web-ui/notifications/contracts.js";
import { projectNotificationEvent } from "../../web-ui/notifications/event-projection.js";
import { WebNotificationService } from "../../web-ui/notifications/service.js";
import { notificationStorePath, WebNotificationStore } from "../../web-ui/notifications/store.js";
// @ts-expect-error Browser navigation module.
import { resolveSparkMessageTarget, sparkNotificationReference } from "../../web-ui/app/lib/spark-chat-address.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/spark-notification-delivery-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  directories.push(directory);
  const paths = { runtimeDir: directory, sessionsDir: join(directory, "sessions") };
  const sessions = new SessionService({ sessionsDir: paths.sessionsDir, now: () => new Date(1000) });
  const deliver = vi.fn(async (_item: WebNotification) => ({ status: "submitted" as const }));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const createService = (viewing = false) => new WebNotificationService({
    hasEnvironment: (id) => id === "dev",
    environment: () => ({ services: { config: { paths } as RuntimeConfig } }),
    isViewing: () => viewing,
    changed: vi.fn(), desktop: async () => ({ available: true }), deliver,
    now: () => 2000,
  });
  const store = new WebNotificationStore(notificationStorePath({ ...paths, environmentId: "dev" }), "dev", { now: () => 2000 });
  return { sessions, deliver, error, createService, store };
}

const proposal = {
  type: "learning.changed", environmentId: "dev",
  event: { type: "proposal_delivered", proposalId: "proposal-1", sessionId: SPARK_SESSION_ID },
};
const rootSource = "/home?environment=dev&spark=1";
const initiativeSource = rootSource + "&message=initiative%3Aproposal-1&messageCreatedAt=1000";

async function persistInitiative(sessions: SessionService) {
  await sessions.appendAssistantInitiative(SPARK_SESSION_ID, {
    title: "A useful next step", content: "Would you like to explore this?",
    initiative: { kind: "proactive_proposal_v1", proposalId: "proposal-1", reason: "A saved interest",
      sources: [{ kind: "candidate", id: "interest", version: "1" }] },
  });
}

test("a persisted SPARK initiative reaches stored history and desktop delivery with its exact message address", async () => {
  const f = await fixture();
  await persistInitiative(f.sessions);
  const service = f.createService(true); // Viewing suppresses replies, never an initiative.
  service.observe(proposal);
  service.observe(proposal);
  await service.flush();
  const page = await service.list("dev");
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    kind: "proposal", sessionId: SPARK_SESSION_ID, sessionKind: "spark",
    sourceUrl: initiativeSource, delivery: { status: "submitted" },
  });
  expect(f.deliver).toHaveBeenCalledOnce();
  expect(f.deliver.mock.calls[0]![0]).toMatchObject({ sourceUrl: initiativeSource, delivery: { status: "pending" } });
  const snapshot = (await f.sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
  const address = new URL(page.items[0]!.sourceUrl, "http://abot.test");
  expect(resolveSparkMessageTarget(snapshot.messages, address.searchParams.get("message"),
    sparkNotificationReference(address))).toBe(snapshot.messages[0]!.id);
  const restarted = f.createService();
  expect((await restarted.list("dev")).items).toEqual(page.items);
  restarted.observe(proposal);
  await restarted.flush();
  expect(f.deliver).toHaveBeenCalledOnce();
  expect(f.error).not.toHaveBeenCalled();
});

test("SPARK replies bind request references while failure and approval can target the companion without a message", async () => {
  const f = await fixture();
  await persistInitiative(f.sessions);
  await f.sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Done", { requestId: "reply-request" });
  const service = f.createService();
  service.observe({ type: "completed", environment: "dev", sessionId: SPARK_SESSION_ID,
    requestId: "reply-request", output: "Done" });
  service.observe({ type: "failed", environment: "dev", sessionId: SPARK_SESSION_ID,
    requestId: "failed-request", error: "Failed" });
  service.observe({ type: "event", name: "tool.approval.required", environment: "dev",
    sessionId: SPARK_SESSION_ID, requestId: "approval-request", approvalId: "approval" });
  await service.flush();
  const items = (await service.list("dev")).items;
  expect(items).toHaveLength(3);
  expect(items.find((item) => item.kind === "reply")).toMatchObject({
    sourceUrl: rootSource + "&message=1&messageCreatedAt=1000&request=reply-request",
    delivery: { status: "submitted" },
  });
  for (const kind of ["failure", "approval"])
    expect(items.find((item) => item.kind === kind)).toMatchObject({ sourceUrl: rootSource, delivery: { status: "submitted" } });
  expect(f.deliver).toHaveBeenCalledTimes(3);
  expect(f.error).not.toHaveBeenCalled();
});

test("ordinary persisted sessions cannot become SPARK through their title, reserved ID or incoming event marker", async () => {
  const f = await fixture();
  for (const sessionId of ["ordinary", SPARK_SESSION_ID]) {
    await f.sessions.getOrCreateSession(sessionId);
    await f.sessions.appendMessage(sessionId, "assistant", "Done", { requestId: sessionId });
  }
  const service = f.createService();
  for (const sessionId of ["ordinary", SPARK_SESSION_ID])
    service.observe({ type: "completed", environment: "dev", sessionId, sessionKind: "spark",
      title: "ABot SPARK", requestId: sessionId, output: "Done" });
  await service.flush();
  const items = (await service.list("dev")).items;
  expect(items).toHaveLength(2);
  for (const item of items) {
    expect(item).not.toHaveProperty("sessionKind");
    expect(item.sourceUrl).toBe("/chat?environment=dev&session=" + item.sessionId);
  }
  expect(f.deliver).toHaveBeenCalledTimes(2);
  expect((await f.createService().list("dev")).items).toEqual(items);
  expect(f.error).not.toHaveBeenCalled();
});

test("stored SPARK sources reject unbound kinds, environments, requests and malformed message destinations", async () => {
  const f = await fixture();
  await persistInitiative(f.sessions);
  const record = await f.sessions.getSessionById(SPARK_SESSION_ID);
  const item = projectNotificationEvent(proposal, 2000, record)!;
  expect((await f.store.upsert(item)).created).toBe(true);
  const invalid = [
    { ...item, sessionKind: undefined },
    { ...item, sessionKind: "ordinary" },
    { ...item, sessionId: "ordinary" },
    { ...item, sourceUrl: initiativeSource.replace("environment=dev", "environment=prod") },
    { ...item, sourceUrl: initiativeSource.replace("/home?", "/chat?") },
    { ...item, sourceUrl: initiativeSource + "&extra=1" },
    { ...item, sourceUrl: initiativeSource + "&spark=1" },
    { ...item, sourceUrl: initiativeSource + "&message=other" },
    { ...item, sourceUrl: initiativeSource + "&messageCreatedAt=1000" },
    { ...item, sourceUrl: initiativeSource + "&request=unbound" },
    { ...item, sourceUrl: initiativeSource + "#message" },
    { ...item, sourceUrl: "//elsewhere.test" + initiativeSource },
    { ...item, sourceUrl: initiativeSource.replace("spark=1", "spark=0") },
    { ...item, sourceUrl: initiativeSource.replace("&messageCreatedAt=1000", "") },
    { ...item, sourceUrl: rootSource + "&messageCreatedAt=1000" },
    { ...item, sourceUrl: rootSource + "&message=&messageCreatedAt=1000" },
    ...["-1", "1.5", "NaN", "9007199254740992", "01"].map((timestamp) =>
      ({ ...item, sourceUrl: initiativeSource.replace("messageCreatedAt=1000", "messageCreatedAt=" + timestamp) })),
    { ...item, requestId: "expected", sourceUrl: initiativeSource },
    { ...item, requestId: "expected", sourceUrl: initiativeSource + "&request=different" },
    { ...item, requestId: "expected", sourceUrl: initiativeSource + "&request=expected&request=expected" },
    { ...item, requestId: "expected", sourceUrl: rootSource + "&request=expected" },
    { ...item, sourceUrl: "/chat?environment=dev&session=" + SPARK_SESSION_ID },
  ];
  for (const malformed of invalid)
    expect(() => f.store.upsert(malformed as WebNotification), JSON.stringify(malformed))
      .toThrow("Invalid notification");
});
