import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  LongTermMemoryManagementService,
  LongTermMemoryRecord,
} from "../long-term-memory/contracts.js";
import { LongTermMemoryManagementError } from "../long-term-memory/index.js";
import type { JsonObject } from "../../web-ui/local-runtime/contracts.js";
import {
  pathSegments,
  readBody,
  readJsonBody,
  sendJson,
} from "../../web-ui/local-runtime/http.js";
import { LongTermMemoryManagementRoutes } from "../../web-ui/local-runtime/memory-management-routes.js";

describe("long-term memory management routes", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  test("lists safe record projections with exact pagination", async () => {
    const list = vi.fn(async () => ({
      items: [createPassiveRecord()],
      total: 1,
    }));
    const baseUrl = await startRouteServer(createService({ list }), servers);

    const response = await fetch(
      `${baseUrl}/web-api/runtime/memory/records?limit=25&offset=0`,
    );
    const payload = await readJsonResponse(response);

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ limit: 25, offset: 0 });
    expect(payload).toEqual({
      ok: true,
      status: { enabled: true, available: true },
      items: [
        {
          id: "memory-1",
          content: "The user's name is Dor.",
          tags: ["identity"],
          origin: "passive_response",
          createdAt: "2026-08-26T10:00:00.000Z",
          updatedAt: "2026-08-26T10:00:00.000Z",
        },
      ],
      total: 1,
    });
    expect(JSON.stringify(payload)).not.toContain("private-session");
    expect(JSON.stringify(payload)).not.toContain("private-request");
    expect(JSON.stringify(payload)).not.toContain("vector");
  });

  test("binds semantic search to the selected service", async () => {
    const search = vi.fn(
      async (
        _input: Parameters<LongTermMemoryManagementService["search"]>[0],
      ) => ({
        items: [createManualRecord()],
        total: 1,
      }),
    );
    const baseUrl = await startRouteServer(createService({ search }), servers);

    const response = await fetch(
      `${baseUrl}/web-api/runtime/memory/records/search?q=user%20name&limit=10`,
    );
    const payload = await readJsonResponse(response);

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        query: "user name",
        limit: 10,
        context: { abortSignal: expect.any(AbortSignal) },
      }),
    );
    expect(payload.items).toEqual([
      expect.objectContaining({ origin: "web_ui" }),
    ]);
  });

  test("binds manual create and exact-ID update without accepting authority fields", async () => {
    const create = vi.fn(async () => ({ record: createManualRecord() }));
    const update = vi.fn(async () => ({
      record: createManualRecord({
        content: "The user's preferred name is Dor.",
        updatedAt: "2026-08-26T11:00:00.000Z",
      }),
      updated: true,
    }));
    const baseUrl = await startRouteServer(
      createService({ create, update }),
      servers,
    );

    const rejected = await fetch(
      `${baseUrl}/web-api/runtime/memory/records`,
      jsonRequest("POST", {
        content: "The user's name is Dor.",
        tags: ["identity"],
        provenance: { kind: "manual" },
      }),
    );
    expect(rejected.status).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const created = await fetch(
      `${baseUrl}/web-api/runtime/memory/records`,
      jsonRequest("POST", {
        content: "The user's name is Dor.",
        tags: ["identity"],
      }),
    );
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "The user's name is Dor.",
        tags: ["identity"],
        source: "web_ui",
        context: { abortSignal: expect.any(AbortSignal) },
      }),
    );

    const updated = await fetch(
      `${baseUrl}/web-api/runtime/memory/records/memory-1`,
      jsonRequest("PATCH", {
        content: "The user's preferred name is Dor.",
        tags: ["identity"],
        expectedUpdatedAt: "2026-08-26T10:00:00.000Z",
      }),
    );
    expect(updated.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "memory-1",
        expectedUpdatedAt: "2026-08-26T10:00:00.000Z",
        context: { abortSignal: expect.any(AbortSignal) },
      }),
    );
  });

  test("maps domain failures without exposing provider details", async () => {
    const create = vi.fn(async () => {
      throw new LongTermMemoryManagementError(
        "long_term_memory_management_sensitive_data",
      );
    });
    const search = vi.fn(async () => {
      throw new LongTermMemoryManagementError("long_term_memory_unavailable", {
        cause: new Error("private provider failure"),
      });
    });
    const deleteMemory = vi.fn(async () => ({ deleted: false }));
    const baseUrl = await startRouteServer(
      createService({ create, search, delete: deleteMemory }),
      servers,
    );

    const sensitive = await fetch(
      `${baseUrl}/web-api/runtime/memory/records`,
      jsonRequest("POST", { content: "secret", tags: [] }),
    );
    expect(sensitive.status).toBe(400);
    expect(await readJsonResponse(sensitive)).toEqual({
      ok: false,
      error: "long_term_memory_management_sensitive_data",
    });

    const unavailable = await fetch(
      `${baseUrl}/web-api/runtime/memory/records/search?q=name`,
    );
    expect(unavailable.status).toBe(503);
    expect(await readJsonResponse(unavailable)).toEqual({
      ok: false,
      error: "long_term_memory_unavailable",
    });

    const missing = await fetch(
      `${baseUrl}/web-api/runtime/memory/records/missing`,
      { method: "DELETE" },
    );
    expect(missing.status).toBe(404);
    expect(await readJsonResponse(missing)).toEqual({
      ok: false,
      error: "long_term_memory_management_not_found",
      memoryId: "missing",
    });
  });
});

function createService(
  overrides: Partial<LongTermMemoryManagementService>,
): LongTermMemoryManagementService {
  return {
    status: async () => ({
      enabled: true,
      available: true,
      recordCount: 0,
      indexedRecordCount: 0,
    }),
    list: async () => ({ items: [], total: 0 }),
    search: async () => ({ items: [], total: 0 }),
    create: async () => ({ record: createManualRecord() }),
    update: async () => ({ record: createManualRecord(), updated: false }),
    delete: async () => ({ deleted: true }),
    ...overrides,
  };
}

function createPassiveRecord(): LongTermMemoryRecord {
  return Object.freeze({
    id: "memory-1",
    content: "The user's name is Dor.",
    tags: Object.freeze(["identity"]),
    provenance: Object.freeze({
      kind: "passive_response" as const,
      sourceSessionId: "private-session",
      sourceRequestId: "private-request",
    }),
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
  });
}

function createManualRecord(
  overrides: Partial<LongTermMemoryRecord> = {},
): LongTermMemoryRecord {
  return Object.freeze({
    id: "memory-1",
    content: "The user's name is Dor.",
    tags: Object.freeze(["identity"]),
    provenance: Object.freeze({
      kind: "manual" as const,
      source: "web_ui" as const,
    }),
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  });
}

async function startRouteServer(
  service: LongTermMemoryManagementService,
  servers: Server[],
): Promise<string> {
  const routes = new LongTermMemoryManagementRoutes(() => service);
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

async function handleRouteRequest(
  routes: LongTermMemoryManagementRoutes,
  request: Parameters<typeof readBody>[0],
  response: Parameters<typeof sendJson>[0],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.slice("/web-api".length) || "/";
  const method = request.method ?? "GET";
  const body = await readRequestBody(request, method);
  const segments = pathSegments(pathname);
  const handled = await routes.handle({
    method,
    route: segments.join("/"),
    segments,
    url,
    body,
    environmentId: "dev",
    request,
    response,
  });
  if (!handled) sendJson(response, 404, { ok: false, error: "not_found" });
}

async function readRequestBody(
  request: Parameters<typeof readBody>[0],
  method: string,
): Promise<JsonObject | null> {
  if (method === "GET" || method === "HEAD") return null;
  return readJsonBody(await readBody(request));
}

function jsonRequest(method: string, body: JsonObject): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function readJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
