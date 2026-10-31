import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import { WebNotificationService } from "../../web-ui/notifications/service.js";
import { WebNotificationStore, notificationStorePath } from "../../web-ui/notifications/store.js";
import { WebSessionRoutes } from "../../web-ui/local-runtime/session-routes.js";
import { SparkChatRoutes } from "../../web-ui/local-runtime/spark-chat-routes.js";
import { pathSegments, readBody, readJsonBody, sendJson } from "../../web-ui/local-runtime/http.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";

const fixtures: Array<{ server: Server; root: string; services: WebNotificationService[] }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { server, root, services } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await Promise.all(services.map((service) => service.stop()));
    await rm(root, { recursive: true, force: true });
  }
});

function reply(requestId: string, sessionId = "chat", environment = "dev") {
  return { type: "completed", requestId, sessionId, environment, output: `Reply ${requestId}` };
}

async function fixture() {
  const artifacts = resolve(".codex/artifacts/notification-read-retention-20261028");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "read-routes-"));
  let now = 1000;
  const environments = new Map<string, RuntimeEnvironment>();
  const environment = (id: string): RuntimeEnvironment => {
    const existing = environments.get(id);
    if (existing) return existing;
    const paths = { runtimeDir: join(root, id), sessionsDir: join(root, id, "sessions") };
    const value = { services: {
      config: { paths },
      sessions: new SessionService({ sessionsDir: paths.sessionsDir, now: () => new Date(now) }),
    } } as unknown as RuntimeEnvironment;
    environments.set(id, value);
    return value;
  };
  let reads = new WebSessionReadStates(environment, () => now);
  const changed = vi.fn();
  const services: WebNotificationService[] = [];
  const readEvidence = vi.fn((id: string, sessionId: string) => reads.assistantReadEvidence(id, sessionId));
  const deliver = vi.fn(async () => ({ status: "unavailable" as const }));
  function createNotifications() {
    const service = new WebNotificationService({
      hasEnvironment: (id) => ["dev", "prod"].includes(id), environment,
      isViewing: () => false, changed, now: () => now,
      readEvidence,
      desktop: async () => ({ available: false }),
      deliver,
    });
    services.push(service);
    return service;
  }
  let notifications = createNotifications();
  const onRead = vi.fn((id: string, sessionId: string) => notifications.observeRead(id, sessionId));
  let sessionsRoute = new WebSessionRoutes(reads, undefined, onRead);
  let sparkRoute = new SparkChatRoutes(environment, reads, undefined, onRead);
  for (const id of ["dev", "prod"]) await reads.initialize(id);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = pathSegments(url.pathname);
      const method = request.method ?? "GET";
      const body = method === "GET" ? null : readJsonBody(await readBody(request));
      const environmentId = url.searchParams.get("environment") ?? "dev";
      if (await sparkRoute.handle({ method, route: segments.join("/"), body, environmentId, request, response })) return;
      if (await sessionsRoute.handle({ method, segments, body, environmentId, environment: environment(environmentId), response, url })) return;
      sendJson(response, 404, { ok: false });
    } catch (error) { sendJson(response, 500, { error: String(error) }); }
  });
  fixtures.push({ server, root, services });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (route: string, body?: unknown) => fetch(origin + route, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  function store(id = "dev") {
    const paths = environment(id).services.config.paths;
    return new WebNotificationStore(notificationStorePath({ ...paths, environmentId: id }), id, { now: () => now });
  }
  return {
    root, environment, onRead, changed, request, store, readEvidence, deliver,
    get reads() { return reads; }, get notifications() { return notifications; },
    setNow(value: number) { now = value; },
    async addReply(requestId: string, sessionId = "chat", id = "dev") {
      now += 100;
      await environment(id).services.sessions.appendMessage(sessionId, "assistant", `Reply ${requestId}`, { requestId });
      return reply(requestId, sessionId, id);
    },
    async restart() {
      await notifications.stop();
      reads = new WebSessionReadStates(environment, () => now);
      notifications = createNotifications();
      sessionsRoute = new WebSessionRoutes(reads, undefined, onRead);
      sparkRoute = new SparkChatRoutes(environment, reads, undefined, onRead);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function readOrdinary(f: Fixture, id: number, environment = "dev") {
  const response = await f.request(`/chat/sessions/chat/read?environment=${environment}`, { readThroughMessageId: id });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
  await f.notifications.flush();
}
async function sparkReceipt(f: Fixture, ids: number[]) {
  const snapshot = (await f.environment("dev").services.sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
  const state = await f.reads.project("dev", snapshot);
  return {
    visibleMessageIds: ids,
    readGeneration: "readGeneration" in state ? state.readGeneration : undefined,
    visibleMessages: snapshot.messages.filter((message) => ids.includes(Number(message.id))),
  };
}

// Read the store directly after route completion: service.list() would reconcile again
// and could conceal a missing route-to-notification callback.
describe("conversation read routes synchronize reply notifications", () => {
  test("partial normal reads preserve newer replies, other environments, nonreply notifications and canonical history", async () => {
    const f = await fixture();
    const first = await f.addReply("first");
    const second = await f.addReply("second");
    const otherEnvironment = await f.addReply("first", "chat", "prod");
    const sessions = f.environment("dev").services.sessions;
    await sessions.startRequestStream("chat", "first");
    await sessions.appendRequestEvent("chat", "first", { type: "event", name: "tool.completed", result: "Preserve evidence" });
    const path = join(f.root, "dev", "sessions", "chat.json");
    const before = await readFile(path, "utf8");
    const snapshot = await sessions.getSessionSnapshot("chat");
    const nonReplies = [
      { ...first, type: "failed", errorCode: "request_failed" },
      { ...first, type: "event", name: "tool.approval.required", approvalId: "approval" },
      { ...first, type: "learning.changed", event: { type: "proposal_delivered", proposalId: "proposal", sessionId: "chat" } },
      { type: "event", name: "automation.run.started", environment: "dev", automationId: "job", runId: "run", status: "running" },
    ];
    for (const event of [first, second, otherEnvironment, ...nonReplies]) f.notifications.observe(event);
    await f.notifications.flush();
    const original = (await f.store().list()).items;
    expect(original).toHaveLength(6);
    await readOrdinary(f, 1);
    const after = await f.store().list();
    expect(after.unreadCount).toBe(5);
    expect(after.items.find((item) => item.kind === "reply" && item.requestId === "first")?.readAt).not.toBeNull();
    expect(after.items.find((item) => item.kind === "reply" && item.requestId === "second")?.readAt).toBeNull();
    expect(after.items.filter((item) => item.kind !== "reply")).toEqual(original.filter((item) => item.kind !== "reply"));
    expect((await f.store("prod").list()).unreadCount).toBe(1);
    expect(f.onRead).toHaveBeenCalledExactlyOnceWith("dev", "chat");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await sessions.getSessionSnapshot("chat")).toEqual(snapshot);
  });

  test("SPARK read receipts clear only the exact visible assistant reply and reject stale receipts", async () => {
    const f = await fixture();
    await ensureSparkSession(f.environment("dev").services.sessions);
    const first = await f.addReply("spark-first", SPARK_SESSION_ID);
    const second = await f.addReply("spark-second", SPARK_SESSION_ID);
    f.notifications.observe(first); f.notifications.observe(second);
    await f.notifications.flush();
    const path = join(f.root, "dev", "sessions", `${SPARK_SESSION_ID}.json`);
    const before = await readFile(path, "utf8");
    const body = await sparkReceipt(f, [2]);
    const response = await f.request("/runtime/spark/chat/read", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ readState: { unreadMessageIds: [1] } });
    await f.notifications.flush();
    const page = await f.store().list();
    expect(page.unreadCount).toBe(1);
    expect(page.items.find((item) => item.requestId === "spark-first")?.readAt).toBeNull();
    expect(page.items.find((item) => item.requestId === "spark-second")?.readAt).not.toBeNull();
    expect(f.onRead).toHaveBeenCalledExactlyOnceWith("dev", SPARK_SESSION_ID);
    const stale = await f.request("/runtime/spark/chat/read", { ...await sparkReceipt(f, [1]), readGeneration: "stale" });
    expect(stale.status).toBe(409);
    expect(f.onRead).toHaveBeenCalledTimes(1);
    expect(await f.store().list()).toEqual(page);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test.each(["before-read", "after-read"])("late notification arrival %s converges on committed read evidence", async (ordering) => {
    const f = await fixture();
    const event = await f.addReply("racing");
    if (ordering === "before-read") f.notifications.observe(event);
    await readOrdinary(f, 1);
    if (ordering === "after-read") f.notifications.observe(event);
    await f.notifications.flush();
    const page = await f.store().list();
    expect(page.items).toHaveLength(1);
    expect(page.unreadCount).toBe(0);
    expect(page.items[0]?.readAt).not.toBeNull();
    f.notifications.observe(event);
    await f.notifications.flush();
    expect(await f.store().list()).toEqual(page);
  });

  test("an explicit unread override survives repeated conversation reads, reconciliation and service restart", async () => {
    const f = await fixture();
    const event = await f.addReply("manual-unread");
    f.notifications.observe(event); await f.notifications.flush();
    await readOrdinary(f, 1);
    const [notification] = (await f.store().list()).items;
    expect(notification?.readAt).not.toBeNull();
    await f.notifications.markRead("dev", { ids: [notification!.id], read: false });
    await readOrdinary(f, 1);
    expect((await f.notifications.list("dev")).unreadCount).toBe(1);
    await f.restart();
    f.notifications.observe(event); await f.notifications.flush();
    await readOrdinary(f, 1);
    expect((await f.notifications.list("dev")).items).toMatchObject([{ id: notification!.id, readAt: null }]);
    await f.notifications.markRead("dev", { ids: [notification!.id], read: true });
    expect((await f.store().list()).unreadCount).toBe(0);
  });

  test("manual unread committed during an in-flight read reconciliation wins", async () => {
    const f = await fixture();
    f.notifications.observe(await f.addReply("manual-race"));
    await f.notifications.flush();
    const [item] = (await f.store().list()).items;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((done) => { release = done; });
    const observed = new Promise<void>((done) => { entered = done; });
    f.readEvidence.mockImplementationOnce(async (id, sessionId) => {
      const evidence = await f.reads.assistantReadEvidence(id, sessionId);
      entered();
      await blocked;
      return evidence;
    });
    const response = await f.request("/chat/sessions/chat/read", { readThroughMessageId: 1 });
    expect(response.status).toBe(200);
    await observed;
    try {
      await f.notifications.markRead("dev", { ids: [item!.id], read: false });
    } finally { release(); }
    await f.notifications.flush();
    expect((await f.store().list()).items).toMatchObject([{ id: item!.id, readAt: null }]);
  });

  test("nonreply notifications never query assistant read evidence before delivery", async () => {
    const f = await fixture();
    const source = await f.addReply("nonreply-source");
    f.notifications.observe({ ...source, type: "failed", errorCode: "request_failed" });
    f.notifications.observe({ ...source, type: "event", name: "tool.approval.required", approvalId: "approval" });
    f.notifications.observe({ ...source, type: "learning.changed", event: { type: "proposal_delivered", proposalId: "proposal", sessionId: "chat" } });
    f.notifications.observe({ type: "event", name: "automation.run.started", environment: "dev", automationId: "job", runId: "run", status: "running" });
    await f.notifications.flush();
    expect((await f.store().list()).items.map((item) => item.kind).sort()).toEqual(["approval", "automation", "failure", "proposal"]);
    expect(f.readEvidence).not.toHaveBeenCalled();
    expect(f.deliver).toHaveBeenCalledTimes(4);
  });

  test("a missing-session read never publishes a notification read observation", async () => {
    const f = await fixture();
    f.notifications.observe(await f.addReply("retained"));
    await f.notifications.flush();
    const before = await f.store().list();
    const response = await f.request("/chat/sessions/missing/read", { readThroughMessageId: 1 });
    expect(response.status).toBe(404);
    expect(f.onRead).not.toHaveBeenCalled();
    expect(await f.store().list()).toEqual(before);
  });
});
