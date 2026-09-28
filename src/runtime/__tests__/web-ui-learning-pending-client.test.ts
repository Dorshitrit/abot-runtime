import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { PassiveLearningRoutes } from "../../web-ui/local-runtime/learning-routes.js";
import {
  pathSegments,
  readBody,
  readJsonBody,
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

test.each([undefined, "prod"])(
  "browser pending deletion reaches the selected environment through the JSON mutation guard (%s)",
  async (environmentId) => {
    const status: PassiveLearningStatus = {
      preferences: { enabled: false, excludedApplications: [] },
      state: "off",
      pendingObservations: 0,
      processing: false,
      droppedObservations: 0,
      recentMemories: [],
    };
    const service: PassiveLearningManagement = {
      status: vi.fn(async () => status),
      configure: vi.fn(async () => status),
      clearPending: vi.fn(async () => status),
      batches: vi.fn(async () => []),
      batch: vi.fn(async () => undefined),
    };
    const resolveService = vi.fn(() => service);
    const received = vi.fn();
    const routes = new PassiveLearningRoutes(resolveService);
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = pathSegments(url.pathname);
      const body = readJsonBody(await readBody(request));
      received(request.method, request.headers["content-type"], body);
      const handled = await routes.handle({
        method: request.method ?? "GET",
        route: segments.join("/"),
        segments,
        url,
        body,
        environmentId: url.searchParams.get("environment") ?? "wrong-fallback",
        request,
        response,
      });
      if (!handled) sendJson(response, 404, { ok: false });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: origin }),
      getEnvironmentId: () => "dev",
      origin,
    });

    await expect(
      client.clearPassiveLearningPending(environmentId),
    ).resolves.toEqual({
      ok: true,
      status,
    });
    expect(received).toHaveBeenCalledExactlyOnceWith(
      "DELETE",
      "application/json",
      {},
    );
    expect(resolveService).toHaveBeenCalledExactlyOnceWith(
      environmentId ?? "dev",
    );
    expect(service.clearPending).toHaveBeenCalledExactlyOnceWith();
    expect(service.configure).not.toHaveBeenCalled();
  },
);
