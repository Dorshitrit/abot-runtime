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

test("host pairing uses shared routes without session, environment or tool-selection writes", async () => {
  const { client, fetchImpl, changeEnvironment } = harness();
  await client.getSystemHostConnection();
  changeEnvironment("dev");
  await client.getSystemHostConnection();
  await client.createSystemHostPairing();
  await client.downloadSystemHostSetup("windows");
  await client.revokeSystemHostConnection();
  expect(fetchImpl.mock.calls).toEqual([
    ["/web-api/runtime/system-host", { headers: {} }],
    ["/web-api/runtime/system-host", { headers: {} }],
    [
      "/web-api/runtime/system-host/pairing",
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
  await expect(client.createSystemHostPairing()).rejects.toThrow(
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
