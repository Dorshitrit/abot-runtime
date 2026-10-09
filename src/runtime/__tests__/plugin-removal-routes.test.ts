import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test, vi } from "vitest";
import { PluginRemovalActivationError } from "../../web-ui/plugin-removal-error.js";
import { PluginManagementError } from "../../web-ui/plugin-management-service.js";
import { ConfigFileConflictError } from "../adapters/config-file-transaction.js";
import { PluginManagementRoutes } from "../../web-ui/local-runtime/plugin-management-routes.js";
const remove = vi.hoisted(() => vi.fn());
vi.mock("../../web-ui/plugin-removal-service.js", () => ({
  removeRuntimePlugin: remove,
}));

async function request(method: string, headers?: Record<string, string>) {
  let status = 0;
  let payload: unknown;
  const runtime = { applyConfiguration: vi.fn(), requireInactive: vi.fn() };
  const routes = new PluginManagementRoutes({
    rootDir: "/test-root",
    getConfigPath: () => "/test-config",
    removalRuntime: runtime,
  });
  const response = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (body: string) => {
      payload = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  await routes.handle({
    method,
    route: "runtime/plugins/remove",
    body: { pluginId: "external" },
    response,
    ...(headers ? { request: { headers, socket: {} } as IncomingMessage } : {}),
  });
  return { status, payload, runtime };
}

test("same-origin explicit POST reaches the removal owner with activation guards", async () => {
  remove.mockReset().mockResolvedValue({ removed: true, plugins: [] });
  const result = await request("POST", {
    host: "localhost:5177",
    origin: "http://localhost:5177",
    "content-type": "application/json",
  });
  expect(result.status).toBe(200);
  expect(remove).toHaveBeenCalledWith(
    { rootDir: "/test-root", configPath: "/test-config", ...result.runtime },
    { pluginId: "external" },
  );
  expect(result.payload).toEqual({ ok: true, removed: true, plugins: [] });
});

test.each([
  ["GET", undefined, 405],
  ["POST", undefined, 403],
  [
    "POST",
    {
      host: "localhost:5177",
      origin: "https://foreign.example",
      "content-type": "application/json",
    },
    403,
  ],
  ["POST", { host: "localhost:5177", "content-type": "text/plain" }, 415],
] as const)(
  "removal rejects %s with invalid request authority or method",
  async (method, headers, expected) => {
    remove.mockClear();
    expect((await request(method, headers)).status).toBe(expected);
    expect(remove).not.toHaveBeenCalled();
  },
);

const headers = {
  host: "localhost:5177",
  origin: "http://localhost:5177",
  "content-type": "application/json",
};
test.each([
  [
    new PluginManagementError("plugin_changed", "Package changed.", 409),
    409,
    "plugin_changed",
    "Package changed.",
  ],
  [new ConfigFileConflictError(), 409, "config_changed", undefined],
  [
    new Error("private filesystem details"),
    500,
    "plugin_removal_failed",
    "Plugin removal could not complete. Refresh plugins before trying again.",
  ],
] as const)(
  "post-Apply failures preserve status and safe error details with activation",
  async (cause, status, code, message) => {
    remove
      .mockReset()
      .mockRejectedValue(
        new PluginRemovalActivationError(cause, { status: "ready" }),
      );
    const result = await request("POST", headers);
    expect(result.status).toBe(status);
    expect(result.payload).toEqual({
      ok: false,
      error: code,
      message: message ?? cause.message,
      activation: { status: "ready" },
    });
  },
);

test("a failure without confirmed Apply has no activation metadata", async () => {
  remove
    .mockReset()
    .mockRejectedValue(
      new PluginManagementError("plugin_runtime_busy", "Busy.", 409),
    );
  expect(await request("POST", headers)).toMatchObject({
    status: 409,
    payload: { error: "plugin_runtime_busy" },
  });
  expect((await request("POST", headers)).payload).not.toHaveProperty(
    "activation",
  );
});
