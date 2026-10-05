import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { SparkChatRoutes } from "../../web-ui/local-runtime/spark-chat-routes.js";
import { WebSessionRoutes } from "../../web-ui/local-runtime/session-routes.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import { WebReadStateStore } from "../../web-ui/session-read-state/store.js";
import { pathSegments, readBody, readJsonBody, sendJson } from "../../web-ui/local-runtime/http.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES, normalizeLearningPreferences } from "../passive-learning/store.js";

const fixtures: Array<{ server: Server; root: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { server, root } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "spark-chat-http-"));
  const environments = new Map<string, RuntimeEnvironment>();
  const executions = vi.fn(async () => {});
  const configure = vi.fn();
  const memoryDelete = vi.fn();
  const clearAttachments = vi.fn(async () => {});
  const getEnvironment = vi.fn((id: string): RuntimeEnvironment => {
    const existing = environments.get(id); if (existing) return existing;
    const paths = { runtimeDir: join(root, id), sessionsDir: join(root, id, "sessions") };
    const preferences = createLearningStateStore(join(root, id, "learning"));
    const status = async () => ({ preferences: (await preferences.read()).preferences });
    const environment = {
      services: {
        config: { paths, models: { profiles: { chosen: {} } } },
        sessions: new SessionService({ sessionsDir: paths.sessionsDir }),
        attachments: { deleteSessionAttachments: clearAttachments },
        longTermMemory: { delete: memoryDelete },
        passiveLearning: {
          status,
          configure: async (input: Parameters<typeof normalizeLearningPreferences>[0]) => {
            configure(input);
            const current = await preferences.read();
            await preferences.write({ ...current, preferences: normalizeLearningPreferences(input, current.preferences) });
            return status();
          },
        },
      }, requests: { handle: executions },
    } as unknown as RuntimeEnvironment;
    environments.set(id, environment); return environment;
  });
  const reads = new WebSessionReadStates(getEnvironment);
  const changed = vi.fn();
  const spark = new SparkChatRoutes(getEnvironment, reads, changed);
  const sessions = new WebSessionRoutes(reads, changed);
  const execution = new LocalRequestExecution(new RealtimeClientHub());
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const route = pathSegments(url.pathname).join("/");
      const method = request.method ?? "GET";
      const body = method === "GET" ? null : readJsonBody(await readBody(request));
      const environmentId = url.searchParams.get("environment") ?? "dev";
      if (await spark.handle({ method, route, body, environmentId, request, response })) return;
      const environment = getEnvironment(environmentId);
      if (route === "chat/messages" && method === "POST") return execution.start(response, body ?? {}, environmentId, environment);
      if (await sessions.handle({ method, segments: pathSegments(url.pathname), body, environmentId, environment, response })) return;
      sendJson(response, 404, { ok: false });
    } catch (error) { sendJson(response, 500, { error: String(error) }); }
  });
  fixtures.push({ root, server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (route = "/runtime/spark/chat", method = "GET", body?: unknown, headers = {}) => fetch(`${origin}${route}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, getEnvironment, changed, executions, configure, memoryDelete, clearAttachments };
}

describe("SPARK companion HTTP contract", () => {
  test("concurrent opens share a marked session and keep environment histories separate", async () => {
    const f = await harness();
    const responses = await Promise.all([f.request(), f.request(), f.request("/runtime/spark/chat?environment=prod")]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sessionId: SPARK_SESSION_ID, toolPermissionMode: "ask", snapshot: { kind: "spark", messages: [] } });
    }
    await f.getEnvironment("dev").services.sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Only dev");
    expect(await (await f.request("/runtime/spark/chat?environment=prod")).json()).toMatchObject({ snapshot: { messages: [] } });
    expect(await (await f.request("/chat/sessions")).json()).toMatchObject({ sessions: [] });
    expect(f.executions).not.toHaveBeenCalled();
  });

  test.each(["missing", "unmarked"])("rejects the reserved ID when its canonical SPARK session is %s", async (state) => {
    const f = await harness();
    const sessions = f.getEnvironment("dev").services.sessions;
    if (state === "unmarked") await sessions.getOrCreateSession(SPARK_SESSION_ID);
    const before = await sessions.getSessionById(SPARK_SESSION_ID);
    const response = await f.request("/chat/messages", "POST", {
      sessionId: SPARK_SESSION_ID, text: "Hello", modelPreference: { profileId: "chosen" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "spark_chat_session_unavailable" });
    expect(f.executions).not.toHaveBeenCalled();
    expect(await sessions.getSessionById(SPARK_SESSION_ID)).toEqual(before);
    const ordinary = await f.request("/chat/messages", "POST", { sessionId: "ordinary", text: "Hello" });
    expect(ordinary.status).toBe(200);
    expect(f.executions).toHaveBeenCalledOnce();
  });

  test("shared configuration is authoritative at request start and does not inherit client FULL+", async () => {
    const f = await harness(); await f.request();
    await f.getEnvironment("dev").services.passiveLearning.configure({ proactiveModelProfileId: "chosen" });
    const response = await f.request("/chat/messages", "POST", {
      sessionId: SPARK_SESSION_ID, text: "Hi", toolPermissionMode: "full_plus", modelPreference: { profileId: "wrong" },
    });
    expect(response.status).toBe(200);
    expect(f.executions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: SPARK_SESSION_ID, toolPermissionMode: "ask", modelPreference: { profileId: "chosen", scope: "all" },
    }), expect.objectContaining({ durableApprovals: true, requestSteering: expect.anything() }));
    const saved = await f.request("/runtime/spark/chat", "PUT", { toolPermissionMode: "full_plus" });
    expect(await saved.json()).toMatchObject({ toolPermissionMode: "full_plus", modelProfileId: "chosen" });
    expect(f.configure).toHaveBeenLastCalledWith({ sparkToolPermissionMode: "full_plus" });
    expect(await (await f.request()).json()).toMatchObject({ toolPermissionMode: "full_plus" });
    expect(DEFAULT_LEARNING_PREFERENCES.sparkToolPermissionMode).toBe("ask");
  });

  test("clear reuses the session and invalidates delayed reads without deleting memory or permissions", async () => {
    const f = await harness(); await f.request();
    const sessions = f.getEnvironment("dev").services.sessions;
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "First");
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Second");
    const before = await (await f.request()).json();
    const mark = await f.request("/runtime/spark/chat/read", "POST", {
      visibleMessageIds: [2], readGeneration: before.readState.readGeneration,
      visibleMessages: before.snapshot.messages.filter((message: { id: number }) => message.id === 2),
    });
    expect(await mark.json()).toMatchObject({ readState: { unreadMessageIds: [1], unreadCount: 1 } });
    const removal = await f.request(`/chat/sessions/${SPARK_SESSION_ID}`, "DELETE", {});
    expect(removal.status).toBe(409);
    await f.request("/runtime/spark/chat", "PUT", { toolPermissionMode: "full_plus" });
    const cleared = await f.request(`/chat/sessions/${SPARK_SESSION_ID}/messages`, "DELETE", {});
    expect(cleared.status).toBe(200);
    await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "After clear");
    const stale = await f.request("/runtime/spark/chat/read", "POST", {
      visibleMessageIds: [1], readGeneration: before.readState.readGeneration,
      visibleMessages: before.snapshot.messages.filter((message: { id: number }) => message.id === 1),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "read_generation_changed" });
    expect(await (await f.request()).json()).toMatchObject({ toolPermissionMode: "full_plus", readState: { unreadMessageIds: [1] } });
    expect(f.clearAttachments).not.toHaveBeenCalled();
    expect(f.memoryDelete).not.toHaveBeenCalled();
  });

  test("rejects invalid or cross-origin configuration before changing permissions", async () => {
    const f = await harness();
    const crossOrigin = await f.request("/runtime/spark/chat", "PUT", { toolPermissionMode: "full_plus" }, { origin: "https://elsewhere.test" });
    expect(crossOrigin.status).toBe(403); expect(f.getEnvironment).not.toHaveBeenCalled();
    const invalid = await f.request("/runtime/spark/chat", "PUT", { toolPermissionMode: "full" });
    expect(invalid.status).toBe(400); expect(f.configure).not.toHaveBeenCalled();
    const hiddenUpdate = await f.request("/runtime/spark/chat", "PUT", { toolPermissionMode: "ask", proactiveEnabled: true });
    expect(hiddenUpdate.status).toBe(400); expect(f.configure).not.toHaveBeenCalled();
  });

  test("reports model configuration failures without starting a request", async () => {
    const f = await harness(); await f.request();
    const missing = await f.request("/chat/messages", "POST", { sessionId: SPARK_SESSION_ID, text: "Hello" });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: "spark_chat_model_required", message: expect.stringContaining("SPARK settings") });
    await f.getEnvironment("dev").services.passiveLearning.configure({ proactiveModelProfileId: "deleted" });
    const unavailable = await f.request("/chat/messages", "POST", { sessionId: SPARK_SESSION_ID, text: "Hello" });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: "spark_chat_model_unavailable", message: expect.stringContaining("SPARK settings") });
    expect(f.executions).not.toHaveBeenCalled();
  });

  test("failed preference or read persistence never acknowledges a saved change", async () => {
    const f = await harness(); await f.request();
    const environment = f.getEnvironment("dev");
    const failure = vi.spyOn(environment.services.passiveLearning, "configure").mockRejectedValueOnce(new Error("disk full"));
    const settings = await f.request("/runtime/spark/chat", "PUT", { toolPermissionMode: "full_plus" });
    expect(settings.status).toBe(409); expect(await settings.json()).toMatchObject({ ok: false });
    failure.mockRestore();
    expect(await (await f.request()).json()).toMatchObject({ toolPermissionMode: "ask" });
    await environment.services.sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Unread");
    const before = await (await f.request()).json();
    const transaction = vi.spyOn(WebReadStateStore.prototype, "transaction").mockRejectedValueOnce(new Error("disk full"));
    const read = await f.request("/runtime/spark/chat/read", "POST", { visibleMessageIds: [1], readGeneration: before.readState.readGeneration,
      visibleMessages: before.snapshot.messages });
    expect(read.status).toBe(409); expect(await read.json()).toMatchObject({ ok: false });
    transaction.mockRestore();
    expect(await (await f.request()).json()).toMatchObject({ readState: { unreadCount: 1 } });
  });

  test("busy clear reports the owner rejection and preserves attachments", async () => {
    const f = await harness(); await f.request();
    vi.spyOn(f.getEnvironment("dev").services.sessions, "clearSessionMessages").mockRejectedValueOnce(new Error("spark_chat_busy"));
    const response = await f.request(`/chat/sessions/${SPARK_SESSION_ID}/messages`, "DELETE", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "spark_chat_busy", message: expect.stringContaining("active request") });
    expect(f.clearAttachments).not.toHaveBeenCalled();
  });
});
