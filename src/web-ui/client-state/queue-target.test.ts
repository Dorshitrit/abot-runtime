import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { WebClientStateRoutes } from "./routes.js";
import { WebClientStateStore } from "./store.js";
import { createRuntimeSessionResetClientState } from "./session-reset.js";
import { validateRuntimeQueueTarget } from "./queue-target.js";
import { composerProductFixture, deferred } from "../composer-lifecycle/__tests__/composer-product-fixture.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(sessionId = "chat-1") {
  const directory = join(process.cwd(), ".codex/artifacts/runtime-reset-spark-read-20261030");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, "queue-target-")); roots.push(root);
  const sessions = new SessionService({ sessionsDir: join(root, "sessions") });
  if (sessionId === SPARK_SESSION_ID) await ensureSparkSession(sessions);
  await sessions.startRequestStream(sessionId, "active");
  await sessions.appendRequestEvent(sessionId, "active", { type: "completed", requestId: "active", output: "Finished" });
  const resolveSessions = vi.fn(() => sessions);
  const replay = vi.spyOn(sessions, "getRequestReplayById");
  const routes = new WebClientStateRoutes(root, undefined, input => validateRuntimeQueueTarget(input, resolveSessions));
  const server = createServer((request, response) => { void routes.handle(request, response, "/web-ui-state"); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl: typeof fetch = (url, input) => fetch(origin + String(url), input);
  const store = new WebClientStateStore(root);
  const reset = createRuntimeSessionResetClientState(root);
  const scope = { environmentId: "prod", sessionId };
  const item = { waitForRequestId: "active", text: "Queued text", attachments: [], agentMode: "reasoning", toolPermissionMode: "ask" };
  const post = (input: Record<string, unknown>) => fetchImpl("/web-ui-state", {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(input),
  });
  return { sessions, resolveSessions, replay, store, reset, fetchImpl, scope, item, post };
}

test("an enqueue racing normal completion remains valid while its request still exists", async () => {
  const f = await fixture();
  const response = await f.post({ kind: "queue", action: "enqueue", scope: f.scope, item: f.item });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(JSON.parse(body.state.queue).queues[0].items[0].text).toBe("Queued text");
  expect(f.resolveSessions).toHaveBeenCalledExactlyOnceWith("prod");
  expect(f.replay).toHaveBeenCalledExactlyOnceWith("active", 0, "chat-1");
});

test.each(["chat-1", SPARK_SESSION_ID])("enqueue submitted during %s reset is refused and restores its captured draft", async sessionId => {
  const f = await fixture(sessionId);
  const composer = await composerProductFixture({ fetchImpl: f.fetchImpl });
  composer.switchSession(sessionId);
  const file = { id: "file", name: "draft.txt", mimeType: "text/plain", storageRef: `${sessionId}/file`, sessionId, environment: "prod" };
  composer.workspace.chatDraft().attachments = [file];
  composer.type("Unsent text"); composer.state.activeRequestId = "active";
  const entered = deferred(); const release = deferred();
  const resetting = f.reset("prod", async () => {
    entered.resolve(); await release.promise;
    if (sessionId === SPARK_SESSION_ID) await f.sessions.clearSessionMessages(sessionId);
    else await f.sessions.deleteSessionWithStats(sessionId);
    return { complete: true, deletedSessionIds: sessionId === SPARK_SESSION_ID ? [] : [sessionId],
      clearedSessionIds: sessionId === SPARK_SESSION_ID ? [sessionId] : [], failedSessionIds: [], deletedMessages: 1, deletedRequests: 1 };
  });
  await entered.promise;
  const transactions = vi.spyOn(WebClientStateStore.prototype, "transaction");
  const submission = composer.composer.submit.dispatch("send_next");
  try {
    await vi.waitFor(() => expect(transactions).toHaveBeenCalledOnce());
    expect(f.resolveSessions).not.toHaveBeenCalled();
  } finally { release.resolve(); }
  await resetting;
  const result = await submission;
  expect(result.status).toBe("refused");
  expect(result.error).toMatchObject({ cause: { code: "queue_target_unavailable", status: 409 } });
  expect(composer.workspace.drafts.open(f.scope).text).toBe("Unsent text");
  expect(composer.workspace.drafts.open(f.scope).attachments).toEqual([file]);
  expect((await f.store.transaction(() => null)).state.queue).toBe("");
  await expect(composer.storage.flush()).rejects.toThrow("no longer available");
});

test("replay fallback from a different conversation cannot authorize an enqueue", async () => {
  const f = await fixture();
  await f.sessions.clearSessionMessages("chat-1");
  await f.sessions.startRequestStream("other", "active");
  const response = await f.post({ kind: "queue", action: "enqueue", scope: f.scope, item: f.item });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "queue_target_unavailable" });
  expect((await f.store.transaction(() => null)).state.queue).toBe("");
});

test("other queue operations retain their existing ownership checks without a Runtime lookup", async () => {
  const f = await fixture();
  const response = await f.post({ kind: "queue", action: "release", scope: f.scope, requestId: "active" });
  expect(response.status).toBe(200);
  expect(f.resolveSessions).not.toHaveBeenCalled();
});
