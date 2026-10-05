import { expect, test, vi } from "vitest";

import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function harness(backend = "runtime") {
  let environment = "prod";
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ ok: true, paired: false, connected: false }),
      ),
  );
  const client = createRuntimeWebClient({
    getConfig: () => ({ backend }),
    getEnvironmentId: () => environment,
    fetchImpl,
    origin: "http://localhost:5184",
  });
  return {
    client,
    fetchImpl,
    changeEnvironment: (value: string) => {
      environment = value;
    },
  };
}

test("host reads scope native metadata by environment while pairing writes remain shared", async () => {
  const { client, fetchImpl, changeEnvironment } = harness();
  await client.getSystemHostConnection();
  changeEnvironment("dev");
  await client.getSystemHostConnection();
  await client.createSystemHostPairing();
  await client.connectLocalSystemHost();
  await client.downloadSystemHostSetup("windows");
  await client.revokeSystemHostConnection();
  expect(fetchImpl.mock.calls).toEqual([
    ["/web-api/runtime/system-host?environment=prod", { headers: {} }],
    ["/web-api/runtime/system-host?environment=dev", { headers: {} }],
    [
      "/web-api/runtime/system-host/pairing",
      {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      },
    ],
    [
      "/web-api/runtime/system-host/connect-local",
      {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      },
    ],
    [
      "/web-api/runtime/system-host/setup",
      {
        method: "POST",
        body: JSON.stringify({ platform: "windows" }),
        headers: { "content-type": "application/json" },
      },
    ],
    [
      "/web-api/runtime/system-host",
      {
        method: "DELETE",
        body: "{}",
        headers: { "content-type": "application/json" },
      },
    ],
  ]);
});

test("bridge backend rejects host configuration locally", async () => {
  const { client, fetchImpl } = harness("bridge");
  expect(client.supportsSystemHostConnection()).toBe(false);
  await expect(client.getSystemHostConnection()).rejects.toThrow(
    "local Runtime backend",
  );
  await expect(client.requestSystemHostPermissions({ action: "check" })).rejects.toThrow("local Runtime backend");
  await expect(client.createSystemHostPairing()).rejects.toThrow(
    "local Runtime backend",
  );
  await expect(client.connectLocalSystemHost()).rejects.toThrow(
    "local Runtime backend",
  );
  await expect(client.downloadSystemHostSetup("macos")).rejects.toThrow(
    "local Runtime backend",
  );
  await expect(client.revokeSystemHostConnection()).rejects.toThrow(
    "local Runtime backend",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("permission preparation uses the shared POST route with explicit live host binding", async () => {
  const { client, fetchImpl } = harness();
  const input = { hostId: "mac", connectionId: "socket", action: "request", permission: "screen_recording" };
  await client.requestSystemHostPermissions(input);
  expect(fetchImpl.mock.calls).toEqual([[
    "/web-api/runtime/system-host/permissions",
    { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } },
  ]]);
});
