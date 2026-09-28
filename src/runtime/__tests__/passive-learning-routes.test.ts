import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PassiveLearningRoutes } from "../../web-ui/local-runtime/learning-routes.js";
import {
  readBody,
  readJsonBody,
  pathSegments,
  sendJson,
} from "../../web-ui/local-runtime/http.js";
import type { PassiveLearningManagement } from "../local-host/client-learning.js";
import type { PassiveLearningStatus } from "../passive-learning/contracts.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function status(): PassiveLearningStatus {
  return {
    preferences: { enabled: false, excludedApplications: [] },
    state: "off",
    pendingObservations: 0,
    processing: false,
    droppedObservations: 0,
    recentMemories: [],
  };
}

async function harness() {
  const service: PassiveLearningManagement = {
    status: vi.fn(async () => status()),
    configure: vi.fn(async () => status()),
    clearPending: vi.fn(async () => status()),
    restartCollection: vi.fn(async () => status()),
    batches: vi.fn(async () => []),
    batch: vi.fn(async () => undefined),
  };
  const resolveService = vi.fn(() => service);
  const routes = new PassiveLearningRoutes(resolveService);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = pathSegments(url.pathname);
    const body =
      request.method === "GET" ? null : readJsonBody(await readBody(request));
    const handled = await routes.handle({
      method: request.method ?? "GET",
      route: segments.join("/"),
      segments,
      url,
      body,
      environmentId: url.searchParams.get("environment") ?? "dev",
      request,
      response,
    });
    if (!handled) sendJson(response, 404, { ok: false });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    service,
    resolveService,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe("passive learning management HTTP boundary", () => {
  test("collection restart is an environment-bound POST and preserves configuration", async () => {
    const { url, service, resolveService } = await harness();
    const target = `${url}/runtime/learning/collection/restart?environment=prod`;
    const response = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, status: status() });
    expect(resolveService).toHaveBeenCalledExactlyOnceWith("prod");
    expect(service.restartCollection).toHaveBeenCalledExactlyOnceWith();
    expect(service.configure).not.toHaveBeenCalled();
    expect(service.clearPending).not.toHaveBeenCalled();
    const read = await fetch(target);
    expect(read.status).toBe(405);
    expect(read.headers.get("allow")).toBe("POST");
    expect((await fetch(`${url}/runtime/learning/collection/restart/other`)).status).toBe(404);
    expect(service.restartCollection).toHaveBeenCalledOnce();
  });

  test.each([
    [{ "content-type": "application/json", origin: "https://unrelated.test" }, 403],
    [{ "content-type": "application/json", "sec-fetch-site": "cross-site" }, 403],
    [{ "content-type": "text/plain" }, 415],
  ] as const)("collection restart rejects unauthorized browser metadata", async (headers, expected) => {
    const { url, service, resolveService } = await harness();
    const response = await fetch(`${url}/runtime/learning/collection/restart`, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(expected);
    expect(resolveService).not.toHaveBeenCalled();
    expect(service.restartCollection).not.toHaveBeenCalled();
  });

  test("cross-origin activation cannot resolve or mutate an environment", async () => {
    const { url, service, resolveService } = await harness();
    const response = await fetch(`${url}/runtime/learning`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://unrelated.test",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(403);
    expect(resolveService).not.toHaveBeenCalled();
    expect(service.configure).not.toHaveBeenCalled();
  });

  test("binds status and writes to the selected environment and disallows observation injection", async () => {
    const { url, service, resolveService } = await harness();
    const response = await fetch(`${url}/runtime/learning?environment=prod`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveService).toHaveBeenCalledWith("prod");
    const rejected = await fetch(`${url}/runtime/learning?environment=prod`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        observations: [{ content: "untrusted" }],
      }),
    });
    expect(rejected.status).toBe(400);
    expect(service.configure).not.toHaveBeenCalled();
    const accepted = await fetch(`${url}/runtime/learning?environment=prod`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        modelProfileId: "local",
        excludedApplications: ["excluded-app"],
        analysisIntervalMinutes: 15,
        analysisWindow: {
          start: "09:00",
          end: "18:00",
          timeZone: "Asia/Jerusalem",
        },
        maxConcurrentBatches: 3,
      }),
    });
    expect(accepted.status).toBe(200);
    expect(service.configure).toHaveBeenCalledWith({
      enabled: true,
      modelProfileId: "local",
      excludedApplications: ["excluded-app"],
      analysisIntervalMinutes: 15,
      analysisWindow: {
        start: "09:00",
        end: "18:00",
        timeZone: "Asia/Jerusalem",
      },
      maxConcurrentBatches: 3,
    });
  });

  test("batch details resolve exact IDs; expired evidence is not reconstructed", async () => {
    const { url, service } = await harness();
    const response = await fetch(`${url}/runtime/learning/batches/expired`);
    expect(response.status).toBe(404);
    expect(service.batch).toHaveBeenCalledWith("expired");
    const list = await fetch(`${url}/runtime/learning/batches`);
    expect(list.status).toBe(200);
    expect(service.batches).toHaveBeenCalledWith({ limit: 20 });
    const mutation = await fetch(`${url}/runtime/learning/batches`, {
      method: "POST",
    });
    expect(mutation.status).toBe(405);
  });

  test("processing pause is independently configurable and must be boolean", async () => {
    const { url, service } = await harness();
    for (const processingPaused of [true, false]) {
      const response = await fetch(`${url}/runtime/learning`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processingPaused }),
      });
      expect(response.status).toBe(200);
      expect(service.configure).toHaveBeenLastCalledWith({ processingPaused });
    }
    for (const processingPaused of ["false", 0, null]) {
      const response = await fetch(`${url}/runtime/learning`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processingPaused }),
      });
      expect(response.status).toBe(400);
    }
    expect(service.configure).toHaveBeenCalledTimes(2);
    expect(service.clearPending).not.toHaveBeenCalled();
  });

  test("pending deletion is explicit and bound to the selected environment", async () => {
    const { url, service, resolveService } = await harness();
    const response = await fetch(
      `${url}/runtime/learning/pending?environment=prod`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, status: status() });
    expect(resolveService).toHaveBeenCalledExactlyOnceWith("prod");
    expect(service.clearPending).toHaveBeenCalledExactlyOnceWith();
    expect(service.configure).not.toHaveBeenCalled();
    const read = await fetch(`${url}/runtime/learning/pending`);
    expect(read.status).toBe(405);
    expect(read.headers.get("allow")).toBe("DELETE");
    expect((await fetch(`${url}/runtime/learning/pending/other`)).status).toBe(
      404,
    );
    expect(service.clearPending).toHaveBeenCalledOnce();
  });

  test.each([
    [
      { "content-type": "application/json", origin: "https://unrelated.test" },
      403,
    ],
    [
      { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      403,
    ],
    [{ "content-type": "text/plain" }, 415],
  ] as const)(
    "pending deletion rejects unauthorized browser metadata before resolving an environment",
    async (headers, expectedStatus) => {
      const { url, service, resolveService } = await harness();
      const response = await fetch(
        `${url}/runtime/learning/pending?environment=prod`,
        {
          method: "DELETE",
          headers,
          body: "{}",
        },
      );
      expect(response.status).toBe(expectedStatus);
      expect(resolveService).not.toHaveBeenCalled();
      expect(service.clearPending).not.toHaveBeenCalled();
    },
  );

  test("does not expose internal paths or provider failures through management errors", async () => {
    const { url, service } = await harness();
    vi.mocked(service.status).mockRejectedValue(
      new Error("private path and provider body"),
    );
    const response = await fetch(`${url}/runtime/learning`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "passive_learning_unavailable",
      message: "passive_learning_unavailable",
    });
  });
});
