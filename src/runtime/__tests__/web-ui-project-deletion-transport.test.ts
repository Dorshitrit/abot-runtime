import { expect, test, vi } from "vitest";
import { createProjectRequests } from "../../web-ui/app/services/runtime-web-client/projects.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

test("delete transport encodes the exact project and captured environment with a JSON mutation body", async () => {
  const requestApi = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true }));
  const client = createProjectRequests({
    requestApi, getEnvironmentId: () => "different",
    getConfig: () => ({ supportsProjects: true }),
  });
  await client.deleteProject("project/with spaces", "captured environment");
  expect(requestApi).toHaveBeenCalledExactlyOnceWith(
    "/projects/project%2Fwith%20spaces?environment=captured%20environment",
    { method: "DELETE", body: "{}" },
  );
});

test("unsupported servers receive no deletion request", async () => {
  const requestApi = vi.fn(async () => ({ ok: true }));
  const client = createProjectRequests({
    requestApi, getEnvironmentId: () => "prod", getConfig: () => ({ supportsProjects: false }),
  });
  await expect(client.deleteProject("project")).rejects.toThrow("unavailable");
  expect(requestApi).not.toHaveBeenCalled();
});

test("composed client sends deletion through the API base with application/json", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
  const client = createRuntimeWebClient({
    getConfig: () => ({ supportsProjects: true, apiBasePath: "/custom-api" }),
    getEnvironmentId: () => "prod", fetchImpl, origin: "http://localhost",
  });
  await client.deleteProject("first", "dev");
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("/custom-api/projects/first?environment=dev");
  const options = fetchImpl.mock.calls[0]?.[1];
  expect(options?.method).toBe("DELETE");
  expect(options?.body).toBe("{}");
  expect(new Headers(options?.headers).get("Content-Type")).toContain("application/json");
});
