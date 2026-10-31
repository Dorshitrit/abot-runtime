import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test, vi } from "vitest";
import type { RuntimeSessionsResetResult } from "../local-host/maintenance-contracts.js";
import { RuntimeMaintenanceRoutes } from "../../web-ui/local-runtime/runtime-maintenance-routes.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";

function fixture() {
  const result = { complete: true, deletedSessionIds: ["one"], clearedSessionIds: ["spark-companion"],
    failedSessionIds: [] as string[], deletedMessages: 3, deletedRequests: 1 } satisfies RuntimeSessionsResetResult;
  const resetSessions = vi.fn(async (): Promise<RuntimeSessionsResetResult> => result);
  const clearLogs = vi.fn(async () => ({ complete: true as const, clearedFiles: 2, removedRotatedFiles: 1 }));
  const resolver = vi.fn(() => ({ services: { maintenance: { resetSessions, clearLogs } } }) as unknown as RuntimeEnvironment);
  const readStates = { resetConversations: vi.fn(async (_id: string, operation: () => Promise<RuntimeSessionsResetResult>) => operation()) };
  const notify = vi.fn();
  const routes = new RuntimeMaintenanceRoutes(resolver, readStates, notify);
  async function invoke(options: { operation?: string; method?: string; body?: Record<string, unknown>; origin?: string } = {}) {
    let status = 0; let body: Record<string, unknown> = {};
    const headers: Record<string, unknown> = {};
    const request = { headers: { host: "127.0.0.1:5177", "content-type": "application/json", origin: options.origin ?? "http://127.0.0.1:5177" }, socket: {} } as IncomingMessage;
    const response = { setHeader: (name: string, value: unknown) => { headers[name] = value; },
      writeHead: (code: number) => { status = code; }, end: (data: string) => { body = JSON.parse(data); } } as unknown as ServerResponse;
    await routes.handle({ method: options.method ?? "POST", route: `runtime/maintenance/${options.operation ?? "sessions"}`,
      body: options.body ?? { confirmed: true }, environmentId: "dev", request, response });
    return { status, body, headers };
  }
  return { result, resetSessions, clearLogs, resolver, readStates, notify, invoke };
}

test("session reset uses selected environment, forgets deleted read-state and resets SPARK generation", async () => {
  const f = fixture();
  expect((await f.invoke()).body).toEqual({ ok: true, result: { ...f.result, resetId: expect.any(String) } });
  expect(f.resolver).toHaveBeenCalledWith("dev");
  expect(f.readStates.resetConversations).toHaveBeenCalledWith("dev", expect.any(Function));
  expect(f.notify).toHaveBeenCalledWith("dev", ["sessions", "client-state"], { ...f.result, resetId: expect.any(String) });
  expect(f.clearLogs).not.toHaveBeenCalled();
});

test("logs are a separate confirmed operation", async () => {
  const f = fixture(); expect((await f.invoke({ operation: "logs" })).status).toBe(200);
  expect(f.clearLogs).toHaveBeenCalledOnce(); expect(f.resetSessions).not.toHaveBeenCalled();
  expect(f.readStates.resetConversations).not.toHaveBeenCalled();
});

test.each([
  { body: {}, status: 400 }, { body: { confirmed: false }, status: 400 },
  { body: { confirmed: true, path: "/other" }, status: 400 },
  { origin: "http://malicious.example", status: 403 }, { method: "GET", status: 405 },
])("rejects unconfirmed, cross-origin or invalid mutation %#", async ({ status, ...options }) => {
  const f = fixture(); expect((await f.invoke(options)).status).toBe(status);
  expect(f.resetSessions).not.toHaveBeenCalled(); expect(f.clearLogs).not.toHaveBeenCalled();
});

test("partial cleanup is truthful and forgets only completed targets", async () => {
  const f = fixture(); f.resetSessions.mockResolvedValue({ ...f.result, complete: false, failedSessionIds: ["failed"] });
  const response = await f.invoke(); expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: true, result: { complete: false, failedSessionIds: ["failed"] } });
  expect(f.readStates.resetConversations).toHaveBeenCalledOnce();
});

test("owner refusal has an actionable error and invalidates views without claiming success", async () => {
  const f = fixture(); f.resetSessions.mockRejectedValue(new Error("runtime_maintenance_pending_approvals"));
  const response = await f.invoke(); expect(response.status).toBe(409);
  expect(response.body).toMatchObject({ ok: false, error: "runtime_maintenance_pending_approvals" });
  expect(f.readStates.resetConversations).toHaveBeenCalledOnce(); expect(f.notify).toHaveBeenCalledOnce();
});
