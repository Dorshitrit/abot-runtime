import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { WebSessionRoutes } from "../../web-ui/local-runtime/session-routes.js";
import { SparkChatRoutes } from "../../web-ui/local-runtime/spark-chat-routes.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import { pathSegments, readBody, readJsonBody, sendJson } from "../../web-ui/local-runtime/http.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

const fixtures: Array<{ server: Server; root: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { server, root } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
async function harness(pageSize?: number) {
  const root = await mkdtemp(join(tmpdir(), "web-history-pages-"));
  const sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const sessions = new SessionService({ sessionsDir });
  const environment = { services: {
    config: { paths: { sessionsDir, runtimeDir: root }, ...(pageSize ? { webUi: { pageSize } } : {}) },
    sessions,
    passiveLearning: { status: async () => ({ preferences: DEFAULT_LEARNING_PREFERENCES }) },
  } } as unknown as RuntimeEnvironment;
  const reads = new WebSessionReadStates(() => environment, () => 0);
  await reads.initialize("dev");
  const routes = new WebSessionRoutes(reads);
  const spark = new SparkChatRoutes(() => environment, reads);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = pathSegments(url.pathname);
      const method = request.method ?? "GET";
      const body = method === "GET" ? null : readJsonBody(await readBody(request));
      if (await spark.handle({ method, route: segments.join("/"), request, response, environmentId: "dev", body })) return;
      if (await routes.handle({ method, segments, url, body, environmentId: "dev", environment, response })) return;
      sendJson(response, 404, {});
    } catch (error) { sendJson(response, 500, { error: String(error) }); }
  });
  fixtures.push({ root, server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createRuntimeWebClient({
    getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "dev", origin,
    fetchImpl: (url, options) => fetch(`${origin}${String(url).replace(/^\/web-api/, "")}`, options),
  });
  async function seed(id: string, count: number, kind?: "spark") {
    const stamp = (i: number) => new Date(1000 + i).toISOString();
    await writeFile(join(sessionsDir, `${id}.json`), JSON.stringify({
      id, kind, title: id, createdAt: stamp(0), updatedAt: stamp(count), lastAgentMode: "reasoning", messageCount: count,
      messages: Array.from({ length: count }, (_, i) => ({ id: `msg-${i + 1}`, role: "assistant", content: `answer ${i + 1}`, createdAt: stamp(i), requestId: `req-${i + 1}` })),
      requests: Array.from({ length: count }, (_, i) => ({
        requestId: `req-${i + 1}`, sessionId: id, status: "completed", createdAt: stamp(i), updatedAt: stamp(i), lastSeqNo: 1,
        events: [{ seqNo: 1, type: "completed", requestId: `req-${i + 1}`, timestamp: stamp(i), payload: { output: `answer ${i + 1}` } }],
      })),
    }));
  }
  return { client, sessions, seed, origin };
}

test("HTTP pages bound history/events but keep full unread and read-through semantics", async () => {
  const h = await harness();
  await h.seed("long", 45);
  const page = await h.client.loadSession("long");
  expect(page.messages).toHaveLength(20);
  expect(page.requests).toHaveLength(20);
  expect(page).not.toHaveProperty("messageIndex");
  expect(page.readState).toMatchObject({ unreadCount: 45, latestAssistantMessageId: 45 });
  const second = await h.client.loadSession("long", "dev", { cursor: page.nextCursor });
  expect(second.messages).toHaveLength(20);
  expect(second.readState).toMatchObject({ unreadCount: 45 });
  const read = await h.client.markSessionRead({ sessionId: "long", readThroughMessageId: 25 });
  expect(read.readState).toMatchObject({ unreadCount: 20, lastReadMessageId: "25" });
  expect(await h.sessions.getSessionById("long")).toMatchObject({ messageCount: 45 });
  const legacy = await fetch(`${h.origin}/chat/sessions/long/messages`).then((response) => response.json());
  expect(legacy.messages).toHaveLength(45);
});

test("configured limit applies to session lists, chat and SPARK without dropping unread", async () => {
  const h = await harness(3);
  for (let index = 0; index < 7; index++) await h.seed(`session-${index}`, 7);
  await h.seed(SPARK_SESSION_ID, 7, "spark");
  const noFullList = vi.spyOn(h.sessions, "getAllSessions");
  const page = await h.client.listSessions("dev", { pinnedSessionIds: ["session-6"] });
  expect(page.sessions).toHaveLength(3);
  expect(page.total).toBe(7);
  expect(page.overview).toMatchObject({ unreadCount: 49 });
  expect((page.overview as { sessions: unknown[] }).sessions).toHaveLength(3);
  expect((page.sessions as Array<{ id: string }>)[0]?.id).toBe("session-6");
  const more = await h.client.listSessions("dev", { pinnedSessionIds: ["session-6"], cursor: page.nextCursor });
  expect(more.sessions).toHaveLength(3);
  expect(noFullList).not.toHaveBeenCalled();
  expect((await h.client.loadSession("session-0")).messages).toHaveLength(3);
  const spark = await h.client.loadSparkChat();
  expect(spark.snapshot.messages).toHaveLength(3);
  expect(spark.snapshot.requests).toHaveLength(3);
  expect(spark.readState.unreadCount).toBe(7);
  const target = await h.client.loadSession(SPARK_SESSION_ID, "dev", { targetMessageId: "1" });
  expect((target.messages as Array<{ id: number }>)[0]?.id).toBe(1);
  expect(target.newerCursor).toBeTruthy();
  const receipt = await h.client.markSparkMessagesRead({ visibleMessageIds: [1], visibleMessages: [{ id: 1, createdAt: 1000, requestId: "req-1" }], readGeneration: spark.readState.readGeneration });
  expect(receipt.readState.unreadCount).toBe(6);
});

test("request links load a bounded older window with events and both cursors", async () => {
  const h = await harness(3);
  await h.seed("old-run", 12);
  const page = await h.client.loadSession("old-run", "dev", { targetRequestId: "req-3" });
  expect((page.messages as Array<{ id: number }>).map((message) => message.id)).toEqual([3, 4, 5]);
  expect((page.requests as Array<{ requestId: string }>).map((request) => request.requestId)).toEqual(["req-3", "req-4", "req-5"]);
  expect(page.nextCursor).toBeTruthy();
  expect(page.newerCursor).toBeTruthy();
  const newer = await h.client.loadSession("old-run", "dev", { cursor: page.newerCursor });
  expect((newer.messages as Array<{ id: number }>).map((message) => message.id)).toEqual([6, 7, 8]);
  const missing = await h.client.loadSession("old-run", "dev", { targetRequestId: "removed-run" });
  expect((missing.messages as Array<{ id: number }>).map((message) => message.id)).toEqual([10, 11, 12]);
});
