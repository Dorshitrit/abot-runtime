import { afterEach, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebClientStateRoutes } from "./routes.js";
// @ts-expect-error Browser module is intentionally shared with the transport tests.
import { createWorkspaceStateStorage } from "../app/services/workspace-state-storage.js";
// @ts-expect-error Browser module.
import { createServerComposerQueue } from "../app/services/server-composer-queue.js";
// @ts-expect-error Browser module.
import { createHomeGuidancePreferences } from "../app/services/home-guidance-preferences.js";
import { createRuntimeWebClient } from "../app/services/runtime-web-client.js";
import { createClientPreferences } from "../app/services/client-preferences.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() { const value = await mkdtemp(join(tmpdir(), "abot-workspace-browser-")); roots.push(value); return value; }
async function serve(directory: string) {
  const routes = new WebClientStateRoutes(directory);
  const server = createServer((req, res) => { void routes.handle(req, res, "/web-ui-state"); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createWorkspaceStateStorage({ fetchImpl: (path: string, options: RequestInit) => fetch(url + path, options) });
  await client.refresh();
  return { url, client };
}

test("fresh browser and different server port retain acknowledged preferences and the queue", async () => {
  const directory = await root();
  const first = await serve(directory);
  const preferences = createClientPreferences(first.client);
  await preferences.savePinnedSessions(["saved-chat"]);
  await preferences.saveSessionSidebar("prod", { archivedSessionIds: ["archived-chat"], orderedSessionIds: ["saved-chat"] });
  await preferences.saveEnvironmentId("prod");
  await preferences.saveSessionIdForEnvironment("prod", "saved-chat");
  await preferences.saveLastToolPermissionMode("full_plus");
  await preferences.saveSessionModes({ "saved-chat": { toolPermissionMode: "ask", savedAt: 1 } });
  await preferences.saveModelPreferences({ "saved-chat": "chosen-model" }, { prod: "chosen-model" });
  await first.client.setItem("abot.spark.launcher.position.v1", '{"x":90,"y":120}');
  await createHomeGuidancePreferences(first.client).markReviewed("prod", { id: "memory", updatedAt: "v1" });
  await first.client.execute({ kind: "introduction" });
  const queue = createServerComposerQueue(first.client);
  await queue.enqueue({ environmentId: "prod", sessionId: "saved-chat" }, {
    waitForRequestId: "running", text: "Keep this text", attachments: [{ storageRef: "attachment" }],
    agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: { profileId: "selected" },
  });
  vi.stubGlobal("localStorage", { getItem() { throw new Error("Old storage must not be read"); } });
  const second = await serve(directory);
  expect(second.url).not.toBe(first.url);
  expect(JSON.parse(second.client.getItem("abot-web.pinnedSessions"))).toEqual(["saved-chat"]);
  expect(createServerComposerQueue(second.client).peek({ environmentId: "prod", sessionId: "saved-chat" })).toMatchObject({ text: "Keep this text", toolPermissionMode: "ask" });
  expect(second.client.snapshot()).toEqual(first.client.snapshot());
  expect(createClientPreferences(second.client).loadSessionSidebar("dev").archivedSessionIds).toEqual([]);
  const separateInstallation = await serve(await root());
  expect(createClientPreferences(separateInstallation.client).loadPinnedSessions()).toEqual([]);
  expect(separateInstallation.client.snapshot().introductionSeen).toBe(false);
// This integration performs many sequential durable writes across three listeners.
}, 15_000);

test("two browser projections cannot independently release the same queued instruction", async () => {
  const directory = await root();
  const first = await serve(directory);
  const second = await serve(directory);
  const a = createServerComposerQueue(first.client);
  const b = createServerComposerQueue(second.client);
  const scope = { environmentId: "prod", sessionId: "same" };
  await a.enqueue(scope, { waitForRequestId: "active", text: "Once", attachments: [], agentMode: "reasoning", toolPermissionMode: "ask" });
  const releases = await Promise.all([a.releaseForTerminal(scope, "active"), b.releaseForTerminal(scope, "active")]);
  expect(releases.filter(Boolean)).toHaveLength(1);
});

test("guidance persists encoded profile names without blocking later messages", async () => {
  const directory = await root();
  const { client: storage } = await serve(directory);
  const guidance = createHomeGuidancePreferences(storage);
  const environments = ["dev~local", "dev!~*'()", "סביבה".repeat(40), "profile".repeat(40), "dev /%?#"];
  for (const environment of environments) {
    await guidance.dismiss(environment, "welcome");
    await guidance.markReviewed(environment, { id: "memory", updatedAt: "v1" });
  }
  const second = await serve(directory);
  const reloaded = createHomeGuidancePreferences(second.client);
  for (const environment of environments) {
    expect(reloaded.dismissed(environment)).toEqual(["welcome"]);
    expect(reloaded.hasReviewed(environment, { id: "memory", updatedAt: "v1" })).toBe(true);
  }
  const send = vi.fn(async () => new Response(JSON.stringify({ requestId: "sent" })));
  const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => environments[0],
    origin: "http://localhost", fetchImpl: send });
  await client.postChatMessage({ text: "hello", attachments: [], sessionId: "test", agentMode: "reasoning", toolPermissionMode: "ask" });
  expect(send).toHaveBeenCalledOnce();
  expect(storage.error()).toBeNull();
});

test("merged preferences update the writer's view before its next edit", async () => {
  const directory = await root();
  const first = await serve(directory);
  const second = await serve(directory);
  const preferences = createClientPreferences(first.client);
  let models = preferences.loadModelPreferences().sessionModels;
  first.client.subscribe(() => { models = preferences.loadModelPreferences().sessionModels; });
  await createClientPreferences(second.client).saveModelPreferences({ other: "other-model" }, {});
  models.own = "first-model";
  await preferences.saveModelPreferences(models, {});
  expect(models).toEqual({ other: "other-model", own: "first-model" });
  models.own = "second-model";
  await preferences.saveModelPreferences(models, {});
  await second.client.refresh();
  expect(createClientPreferences(second.client).loadModelPreferences().sessionModels).toEqual({ other: "other-model", own: "second-model" });
});

test("failed preference persistence remains visible without blocking an independent request", async () => {
  const fetchState = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ state: { version: 1, revision: 0, preferences: {}, queue: "" } }) })
    .mockResolvedValue({ ok: false, json: async () => ({ message: "Disk unavailable" }) });
  const storage = createWorkspaceStateStorage({ fetchImpl: fetchState });
  await storage.refresh();
  await expect(storage.setItem("abot-web.lastToolPermissionMode", "ask")).rejects.toThrow("Disk unavailable");
  const send = vi.fn(async () => new Response('{"requestId":"sent"}'));
  const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "prod", origin: "http://localhost", fetchImpl: send });
  await expect(client.postChatMessage({ text: "hello", attachments: [], sessionId: "test", agentMode: "reasoning", toolPermissionMode: "ask" })).resolves.toBe("sent");
  expect(send).toHaveBeenCalledOnce();
  expect(storage.error().message).toBe("Disk unavailable");
});

test("cross-site changes are rejected before creating workspace state", async () => {
  const { url, client } = await serve(await root());
  const response = await fetch(url + "/web-ui-state", { method: "POST", headers: { "content-type": "application/json", origin: "https://other.example" }, body: JSON.stringify({ kind: "introduction" }) });
  expect(response.status).toBe(403);
  await client.refresh();
  expect(client.snapshot().introductionSeen).toBe(false);
});

test("review receipts retain only one revision per memory, cap their size, and forget deleted memories", async () => {
  const values = new Map<string, string>();
  const preferences = createHomeGuidancePreferences({ getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
  for (let index = 0; index < 250; index += 1) preferences.markReviewed("prod", { id: String(index), updatedAt: "v1" });
  preferences.markReviewed("prod", { id: "249", updatedAt: "v2" });
  const saved = JSON.parse(values.get("abot-web.homeGuidance.prod")!);
  expect(saved.reviewed).toHaveLength(200);
  expect(saved.reviewed.filter((record: { id: string }) => record.id === "249")).toEqual([{ id: "249", updatedAt: "v2" }]);
  expect(preferences.hasReviewed("prod", { id: "249", updatedAt: "v1" })).toBe(false);
  preferences.forgetReviewed("prod", "249");
  expect(preferences.hasReviewed("prod", { id: "249", updatedAt: "v2" })).toBe(false);
});


test.each(["constructor", "prototype", "__proto__"])("reserved-word environment %s roundtrips through safe preference maps", async (environment) => {
  const directory = await root();
  const first = await serve(directory);
  const second = await serve(directory);
  const preferences = createClientPreferences(first.client);
  expect(preferences.sessionIdForEnvironment(environment)).toBe("");
  const models = preferences.loadModelPreferences();
  models.lastModelByEnvironment[environment] = "chosen";
  await Promise.all([
    preferences.saveModelPreferences(models.sessionModels, models.lastModelByEnvironment),
    createClientPreferences(second.client).saveModelPreferences({}, { other: "independent" }),
  ]);
  await preferences.saveSessionIdForEnvironment(environment, "session");
  await preferences.saveSessionSidebar(environment, { archivedSessionIds: ["old"], orderedSessionIds: ["session"] });
  const reopened = await serve(directory);
  const restored = createClientPreferences(reopened.client);
  expect(restored.sessionIdForEnvironment(environment)).toBe("session");
  expect(restored.loadModelPreferences().lastModelByEnvironment).toEqual({ [environment]: "chosen", other: "independent" });
  expect(restored.loadSessionSidebar(environment).archivedSessionIds).toEqual(["old"]);
  expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  const send = vi.fn(async () => new Response('{"requestId":"sent"}'));
  const client = createRuntimeWebClient({ getConfig: () => ({}), getEnvironmentId: () => environment, origin: "http://localhost",
    fetchImpl: send });
  await client.postChatMessage({ text: "hello", attachments: [], sessionId: "session", agentMode: "reasoning", toolPermissionMode: "ask" });
  expect(send).toHaveBeenCalledOnce();
});

test("recovered queue ownership survives reload and requires an explicit atomic handoff", async () => {
  const directory = await root();
  const first = await serve(directory);
  const second = await serve(directory);
  const a = createServerComposerQueue(first.client);
  const b = createServerComposerQueue(second.client);
  const scope = { environmentId: "prod", sessionId: "same" };
  const item = { waitForRequestId: "active", text: "Once", attachments: [], agentMode: "reasoning", toolPermissionMode: "ask" };
  await a.enqueue(scope, item);
  const released = await a.releaseForTerminal(scope, "active");
  const claims = await Promise.all([a, b].map((queue) => queue.claimBlockedRelease(scope, released.releaseToken)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims[0]).toMatchObject({ owner: { state: "editing" } });
  expect(await b.beginBlockedSend(scope, released.releaseToken)).toBe(false);
  expect(await b.updateBlockedRelease(scope, released.releaseToken, { ...item, text: "stale" })).toBe(false);
  const takeover = await b.claimBlockedRelease(scope, released.releaseToken, { takeover: true });
  expect(takeover.releaseToken).not.toBe(released.releaseToken);
  expect(await a.beginBlockedSend(scope, released.releaseToken)).toBe(false);
  expect(await a.bindReleasedSuccess(scope, released.releaseToken, "unrelated")).toBe(false);
  expect(await b.beginBlockedSend(scope, takeover.releaseToken)).toBe(true);
  expect(await b.beginBlockedSend(scope, takeover.releaseToken)).toBe(false);
  expect(await b.markBlockedUncertain(scope, takeover.releaseToken)).toBe(true);
  const restarted = createServerComposerQueue((await serve(directory)).client);
  expect(await restarted.claimBlockedRelease(scope, takeover.releaseToken)).toBeNull();
  expect(await restarted.rebindBlocked(scope, "some-streaming-request")).toBe(false);
  const resumed = await restarted.claimBlockedRelease(scope, takeover.releaseToken, { takeover: true });
  expect(await b.beginBlockedSend(scope, takeover.releaseToken)).toBe(false);
  expect(await restarted.beginBlockedSend(scope, resumed.releaseToken)).toBe(true);
  expect(await restarted.bindReleasedSuccess(scope, resumed.releaseToken, "confirmed")).toBe(true);
  expect(restarted.getBlockedRelease(scope)).toBeNull();
});

test("shared memory deletion retires only a confirmed deleted record in its original environment", async () => {
  const { client: storage } = await serve(await root());
  const guidance = createHomeGuidancePreferences(storage);
  const record = { id: "reviewed-memory", updatedAt: "v1" };
  await guidance.markReviewed("prod", record);
  await guidance.markReviewed("dev", record);
  let environment = "prod";
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((done) => { resolve = done; });
  const fetchImpl = vi.fn(() => response);
  const client = createRuntimeWebClient({ getConfig: () => ({}), getEnvironmentId: () => environment, origin: "http://localhost", fetchImpl,
    onMemoryDeleted: (target, id) => guidance.forgetReviewed(target, id) });
  const deleting = client.deleteLongTermMemory({ id: record.id });
  environment = "dev";
  resolve(new Response('{"deleted":true}'));
  await deleting;
  expect(guidance.hasReviewed("prod", record)).toBe(false);
  expect(guidance.hasReviewed("dev", record)).toBe(true);
  fetchImpl.mockResolvedValueOnce(new Response('{"deleted":false}'));
  await client.deleteLongTermMemory({ id: record.id });
  expect(guidance.hasReviewed("dev", record)).toBe(true);
  fetchImpl.mockResolvedValueOnce(new Response('{"error":"failed"}', { status: 500 }));
  await expect(client.deleteLongTermMemory({ id: record.id })).rejects.toThrow();
  expect(guidance.hasReviewed("dev", record)).toBe(true);
});


test("HTTP LAN browsers without randomUUID still receive distinct queue identities", async () => {
  const randomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal("crypto", { getRandomValues: randomValues });
  const directory = await root();
  const a = createServerComposerQueue((await serve(directory)).client);
  const b = createServerComposerQueue((await serve(directory)).client);
  const scope = { environmentId: "prod", sessionId: "same" };
  await a.enqueue(scope, { waitForRequestId: "active", text: "Once", attachments: [], agentMode: "reasoning", toolPermissionMode: "ask" });
  const released = await a.releaseForTerminal(scope, "active");
  expect(await a.claimBlockedRelease(scope, released.releaseToken)).not.toBeNull();
  expect(await b.claimBlockedRelease(scope, released.releaseToken)).toBeNull();
});
