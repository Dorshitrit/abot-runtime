import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { LongTermMemoryManagementRoutes } from "../../web-ui/local-runtime/memory-management-routes.js";
import { pathSegments, readBody, readJsonBody, sendJson } from "../../web-ui/local-runtime/http.js";
import { LongTermMemoryManagementError } from "../long-term-memory/management/errors.js";
import type { LongTermMemoryManagementService, MemoryCandidatePromoteInput } from "../long-term-memory/management/contracts.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { LocalMemoryDispatcher } from "../local-host/app-memory-dispatch.js";
import { createLocalMemoryClient } from "../local-host/client-memory.js";
import type { LocalRuntimePeer } from "../local-host/contracts.js";
// @ts-expect-error Browser-only client has no declaration surface.
import { createLongTermMemoryRequests } from "../../web-ui/app/services/runtime-web-client/memory.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });
const record = { id: "saved", content: "Approved content", tags: [], provenance: { kind: "manual" as const, source: "web_ui" as const },
  automaticManagement: "protected" as const, createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z" };

async function serverFixture() {
  const promoteCandidate = vi.fn(async (_input: MemoryCandidatePromoteInput) => ({ record }));
  const deleteCandidate = vi.fn(async (_input: unknown) => ({ deleted: true }));
  const service = { promoteCandidate, deleteCandidate } as unknown as LongTermMemoryManagementService;
  const resolveService = vi.fn(() => service);
  const routes = new LongTermMemoryManagementRoutes(resolveService);
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = pathSegments(url.pathname);
    const method = request.method ?? "GET";
    const body = method === "GET" ? null : readJsonBody(await readBody(request));
    const handled = await routes.handle({ method, route: segments.join("/"), segments, url, body,
      environmentId: typeof body?.environment === "string" ? body.environment : "dev", request, response });
    if (!handled) sendJson(response, 404, { ok: false });
  })().catch(() => sendJson(response, 500, { ok: false })); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { promoteCandidate, deleteCandidate, resolveService, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({ method,
  headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("candidate HTTP actions bind exact id/revision to owner context and project a safe receipt", async () => {
  const f = await serverFixture();
  const response = await fetch(`${f.base}/runtime/memory/candidates/candidate%20one/promote`, json("POST", { environment: "prod", revision: 2 }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, record: { id: "saved", origin: "web_ui" } });
  expect(f.resolveService).toHaveBeenCalledWith("prod");
  expect(f.promoteCandidate).toHaveBeenCalledWith({ id: "candidate one", revision: 2, source: "web_ui", context: { abortSignal: expect.any(AbortSignal) } });
  expect(response.headers.get("cache-control")).toBe("no-store");
  const deleted = await fetch(`${f.base}/runtime/memory/candidates/candidate%20one`, json("DELETE", { revision: 2 }));
  expect(await deleted.json()).toEqual({ ok: true, deleted: true });
  expect(f.deleteCandidate).toHaveBeenCalledWith({ id: "candidate one", revision: 2 });
});

test("candidate HTTP actions reject foreign origins, unsupported methods and model-supplied content or targets", async () => {
  const f = await serverFixture();
  const route = `${f.base}/runtime/memory/candidates/known/promote`;
  expect((await fetch(route, json("POST", { revision: 2 }, { origin: "https://foreign.example" }))).status).toBe(403);
  expect((await fetch(route, json("POST", { revision: 2, content: "Forged", replacement: { id: "other" } }))).status).toBe(400);
  expect((await fetch(route, json("POST", { revision: 0 }))).status).toBe(400);
  expect((await fetch(route)).status).toBe(405);
  expect(f.promoteCandidate).not.toHaveBeenCalled();
  expect(f.deleteCandidate).not.toHaveBeenCalled();
});

test("candidate conflict is a failed receipt and never reported as successful promotion", async () => {
  const f = await serverFixture();
  f.promoteCandidate.mockRejectedValueOnce(new LongTermMemoryManagementError("long_term_memory_management_conflict"));
  const response = await fetch(`${f.base}/runtime/memory/candidates/known/promote`, json("POST", { revision: 2 }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, error: "long_term_memory_management_conflict" });
});

test("browser candidate requests carry environment and revision without submitting candidate text", async () => {
  const requestApi = vi.fn(async () => ({}));
  const client = createLongTermMemoryRequests({ requestApi, getEnvironmentId: () => "dev", environmentQuery: encodeURIComponent });
  await client.promoteLearningCandidate({ id: "candidate/one", revision: 4 });
  await client.deleteLearningCandidate({ id: "candidate/one", revision: 4, environmentId: "prod" });
  expect(requestApi.mock.calls).toEqual([
    ["/runtime/memory/candidates/candidate%2Fone/promote", { method: "POST", body: JSON.stringify({ environment: "dev", revision: 4 }) }],
    ["/runtime/memory/candidates/candidate%2Fone", { method: "DELETE", body: JSON.stringify({ environment: "prod", revision: 4 }) }],
  ]);
});

test("candidate IPC reconstructs the trusted abort signal and keeps deletion revision-bound", async () => {
  let capturedSignal: AbortSignal | undefined;
  const promoteCandidate = vi.fn(async (input: MemoryCandidatePromoteInput) => { capturedSignal = input.context.abortSignal; return { record }; });
  const deleteCandidate = vi.fn(async (_input: unknown) => ({ deleted: true }));
  const owner = new LocalMemoryDispatcher({ promoteCandidate, deleteCandidate } as unknown as LongTermMemoryService);
  const peer: LocalRuntimePeer = { id: "web", onClose: () => () => {}, callClient: async () => undefined };
  const call = vi.fn(async (method: string, args: readonly unknown[]) => owner.call(method, args, peer));
  const client = createLocalMemoryClient(call, true).service;
  const abortSignal = new AbortController().signal;
  await client.promoteCandidate!({ id: "candidate", revision: 2, source: "web_ui", context: { abortSignal } });
  expect(capturedSignal).toBeInstanceOf(AbortSignal);
  expect(capturedSignal).not.toBe(abortSignal);
  expect((call.mock.calls[0][1][0] as { context: unknown }).context).toEqual({});
  await client.deleteCandidate!({ id: "candidate", revision: 2 });
  expect(deleteCandidate).toHaveBeenCalledWith({ id: "candidate", revision: 2 });
});
