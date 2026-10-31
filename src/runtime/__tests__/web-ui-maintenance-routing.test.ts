import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRuntimeApiRouter } from "../../web-ui/local-runtime/api-router.js";
import type { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import type { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import type { ResolvedLocalRuntimeBackendOptions } from "../../web-ui/local-runtime/contracts.js";
import type { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : done());
  })));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = join(process.cwd(), ".codex/artifacts/runtime-reset-spark-read-20261030");
  await mkdir(directory, { recursive: true });
  const rootDir = await mkdtemp(join(directory, "router-test-")); roots.push(rootDir);
  const result = { complete: true, deletedSessionIds: ["deleted"], clearedSessionIds: ["spark-companion"],
    failedSessionIds: [], deletedMessages: 4, deletedRequests: 2 };
  const resetSessions = vi.fn(async () => result);
  const clearLogs = vi.fn(async () => ({ complete: true, clearedFiles: 3, removedRotatedFiles: 2 }));
  const get = vi.fn(() => ({ services: { maintenance: { resetSessions, clearLogs } } }));
  const resetConversations = vi.fn(async (_environmentId: string, operation: typeof resetSessions) => operation());
  const notify = vi.fn();
  const router = new LocalRuntimeApiRouter(
    { rootDir, defaultEnvironmentId: "prod", providerAdapters: {} } as ResolvedLocalRuntimeBackendOptions,
    { get } as unknown as RuntimeEnvironmentRegistry,
    {} as LocalRequestExecution,
    notify,
    { resetConversations } as unknown as WebSessionReadStates,
  );
  const server = createServer((request, response) => {
    void router.handle(request, response).catch(error => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (action: string, confirmed = true, headers = {}) => fetch(
    `${origin}/web-api/runtime/maintenance/${action}?environment=dev`, {
      method: "POST", headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify({ confirmed }),
    });
  return { origin, post, get, resetSessions, clearLogs, resetConversations, notify, result };
}

test("real router binds session reset to the selected environment and reconciles only its returned IDs", async () => {
  const f = await fixture();
  const response = await f.post("sessions");
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload).toEqual({ ok: true, result: { ...f.result, resetId: expect.any(String) } });
  expect(f.get).toHaveBeenCalledExactlyOnceWith("dev");
  expect(f.resetSessions).toHaveBeenCalledOnce();
  expect(f.clearLogs).not.toHaveBeenCalled();
  expect(f.resetConversations).toHaveBeenCalledExactlyOnceWith("dev", expect.any(Function));
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("dev", ["sessions", "client-state"], payload.result);
});

test("log reset is independent from session deletion in the actual router", async () => {
  const f = await fixture();
  const response = await f.post("logs");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, result: { complete: true, clearedFiles: 3, removedRotatedFiles: 2 } });
  expect(f.get).toHaveBeenCalledExactlyOnceWith("dev");
  expect(f.clearLogs).toHaveBeenCalledOnce();
  expect(f.resetSessions).not.toHaveBeenCalled();
  expect(f.resetConversations).not.toHaveBeenCalled();
});

test("router rejects missing confirmation and cross-origin reset before contacting the owner", async () => {
  const f = await fixture();
  expect((await f.post("sessions", false)).status).toBe(400);
  expect((await f.post("logs", true, { origin: "https://untrusted.invalid" })).status).toBe(403);
  expect(f.get).not.toHaveBeenCalled();
});
