import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { SparkChatRoutes } from "../../web-ui/local-runtime/spark-chat-routes.js";
import { readBody, readJsonBody, sendJson } from "../../web-ui/local-runtime/http.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import type { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import type { RuntimeEnvironmentServices } from "../composition.js";

const fixtures: Array<{ server: Server; root: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { server, root } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-handoff-"));
  const environments = new Map<string, SessionService>();
  const requests = vi.fn(); const learning = vi.fn(); const memory = vi.fn(); const notified = vi.fn();
  const sessions = (id = "dev") => {
    let value = environments.get(id);
    if (!value) { value = new SessionService({ sessionsDir: join(root, id) }); environments.set(id, value); }
    return value;
  };
  const resolve = vi.fn((id: string) => {
    const owner: Pick<RuntimeEnvironmentServices, "sessions"> = { sessions: sessions(id) };
    const clients = createLocalServiceClients((method, args) => dispatchLocalServiceCall(owner as RuntimeEnvironmentServices, method, JSON.parse(JSON.stringify(args))));
    return { services: { ...clients, passiveLearning: { status: learning }, longTermMemory: { query: memory } },
      requests: { handle: requests } } as unknown as RuntimeEnvironment;
  });
  const routes = new SparkChatRoutes(resolve, {} as WebSessionReadStates, notified);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const body = request.method === "GET" ? null : readJsonBody(await readBody(request));
    const handled = await routes.handle({ method: request.method ?? "GET", route: url.pathname.slice(1), body,
      environmentId: url.searchParams.get("environment") ?? "dev", request, response });
    if (!handled) sendJson(response, 404, { ok: false });
  });
  fixtures.push({ root, server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (message: unknown, environment = "dev", extra = {}, headers = {}) => fetch(`${origin}/runtime/spark/chat/sessions?environment=${environment}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ message, ...extra }),
  });
  async function proposal(environment = "dev", legacy = false) {
    const store = sessions(environment); await ensureSparkSession(store);
    await store.appendAssistantInitiative(SPARK_SESSION_ID, {
      title: "Original insight", content: "I noticed an opportunity. Would this be useful?",
      initiative: { kind: "proactive_proposal_v1", proposalId: "one-proposal", reason: "Original model reasoning",
        sources: [{ kind: "memory", id: "source", version: "one" }],
        ...(!legacy ? { handoffBrief: "Background from the original observation. The preference may have changed; wait for the user's direction.", handoffTitle: "Original insight" } : {}),
      },
    });
    const snapshot = (await store.getSessionSnapshot(SPARK_SESSION_ID))!;
    const { id, createdAt, requestId } = snapshot.messages[0]!;
    return { id, createdAt, requestId };
  }
  return { sessions, post, proposal, requests, learning, memory, notified, resolve };
}

describe("SPARK explicit work-session handoff", () => {
  test("concurrent clicks create one ordinary session with only the saved assistant context and no execution", async () => {
    const f = await fixture(); const source = await f.proposal();
    const replies = await Promise.all(Array.from({ length: 4 }, () => f.post(source, "dev", { text: "Run now", handoffBrief: "Forged brief", toolPermissionMode: "full_plus" })));
    for (const response of replies) expect(response.status).toBe(200);
    const bodies = await Promise.all(replies.map((response) => response.json()));
    expect(new Set(bodies.map((body) => body.sessionId)).size).toBe(1);
    const target = (await f.sessions().getSessionById(bodies[0].sessionId))!;
    expect(target.kind).toBeUndefined(); expect(target.automationOrigin).toBeUndefined(); expect(target.title).toBe("Original insight");
    expect(target.messages).toHaveLength(1);
    expect(target.messages[0]).toMatchObject({ role: "assistant", source: "co_worker", grounding: "conversation",
      content: "Background from the original observation. The preference may have changed; wait for the user's direction." });
    expect(target.requests ?? []).toEqual([]);
    expect(await f.sessions().getAllSessions()).toHaveLength(2);
    expect(f.requests).not.toHaveBeenCalled(); expect(f.learning).not.toHaveBeenCalled(); expect(f.memory).not.toHaveBeenCalled();
    expect(f.notified).toHaveBeenCalledWith("dev", ["sessions"]);
  });

  test("same proposal IDs stay environment scoped and repeats reuse the original target", async () => {
    const f = await fixture(); const dev = await f.proposal();
    const crossEnvironment = await f.post(dev, "prod");
    expect(await crossEnvironment.json()).toMatchObject({ error: "spark_handoff_source_unavailable" });
    const prod = await f.proposal("prod");
    const first = await (await f.post(dev)).json(); const second = await (await f.post(prod, "prod")).json();
    expect(first.sessionId).toBe(second.sessionId);
    await f.sessions().appendMessage(first.sessionId, "user", "My current request");
    expect(await (await f.post(dev)).json()).toMatchObject({ sessionId: first.sessionId });
    expect((await f.sessions().getSessionById(first.sessionId))?.messages).toHaveLength(2);
    expect((await f.sessions("prod").getSessionById(second.sessionId))?.messages).toHaveLength(1);
  });

  test("stale, cleared, ordinary, and legacy sources fail without reconstructing context", async () => {
    const f = await fixture(); const source = await f.proposal();
    for (const message of [{ ...source, createdAt: source.createdAt + 1 }, { ...source, requestId: "other" }, { ...source, id: "ordinary" }]) {
      expect(await (await f.post(message)).json()).toMatchObject({ error: "spark_handoff_source_unavailable" });
    }
    await f.sessions().clearSessionMessages(SPARK_SESSION_ID);
    expect(await (await f.post(source)).json()).toMatchObject({ error: "spark_handoff_source_unavailable" });
    const legacy = await f.proposal("legacy", true);
    expect(await (await f.post(legacy, "legacy")).json()).toMatchObject({ error: "spark_handoff_brief_unavailable" });
    expect(f.requests).not.toHaveBeenCalled(); expect(f.memory).not.toHaveBeenCalled();
  });

  test("cleared target and failed persistence return clear failures without overwriting or false success", async () => {
    const f = await fixture(); const source = await f.proposal();
    const first = await (await f.post(source)).json();
    await f.sessions().clearSessionMessages(first.sessionId);
    expect(await (await f.post(source)).json()).toMatchObject({ error: "spark_handoff_target_conflict" });
    expect((await f.sessions().getSessionById(first.sessionId))?.messages).toHaveLength(0);
    vi.spyOn(f.sessions(), "createAssistantConversation").mockRejectedValueOnce(new Error("disk full"));
    const failed = await f.post(source);
    expect(failed.status).toBe(500); expect(await failed.json()).toMatchObject({ error: "spark_handoff_failed", message: expect.not.stringContaining("disk") });
    expect(f.requests).not.toHaveBeenCalled();
  });

  test("rejects cross-origin and malformed input before any environment work", async () => {
    const f = await fixture();
    const crossOrigin = await f.post({}, "dev", {}, { origin: "https://elsewhere.test" });
    expect(crossOrigin.status).toBe(403);
    const invalid = await f.post({ id: "initiative:one", createdAt: 42 });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: "spark_handoff_reference_invalid" });
    expect(f.resolve).not.toHaveBeenCalled();
  });
});
