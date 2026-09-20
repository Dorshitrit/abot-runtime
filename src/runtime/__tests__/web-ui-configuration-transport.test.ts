import { expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

test("configuration writes use JSON and captured environment without leaking the key into URLs", async () => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ ok: true })),
  );
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api" }),
    getEnvironmentId: () => "prod one",
    origin: "http://localhost:5177",
    fetchImpl,
  });
  const input = {
    provider: "openai",
    model: "model-fixture",
    apiKey: "synthetic-key",
    deferActivation: true,
  };
  await client.saveRuntimeSetup(input);
  expect(fetchImpl.mock.calls[0]).toEqual([
    "/web-api/runtime/setup?environment=prod%20one",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
  ]);
  await client.setRuntimePlugin(
    { pluginId: "filesystem", enabled: false },
    "dev",
  );
  await client.applyRuntimeConfiguration("dev");
  expect(fetchImpl.mock.calls[1][0]).toBe(
    "/web-api/runtime/plugins?environment=dev",
  );
  expect(fetchImpl.mock.calls[2][0]).toBe(
    "/web-api/runtime/config/apply?environment=dev",
  );
  expect(input.apiKey).toBe("synthetic-key");
});

test("a capability toggle carries only the selected tool and captured environment", async () => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ ok: true })),
  );
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api" }),
    getEnvironmentId: () => "prod",
    origin: "http://localhost:5177",
    fetchImpl,
  });
  const input = {
    pluginId: "filesystem",
    capabilityId: "read_file",
    enabled: false,
  };
  await client.setRuntimePlugin(input, "dev");
  expect(fetchImpl.mock.calls[0]).toEqual([
    "/web-api/runtime/plugins?environment=dev",
    {
      method: "PUT",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
  ]);
});

test("embedding setup scopes its write and preserves sanitized partial-save feedback", async () => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "embedding_probe_failed",
          message: "The embedding check failed.",
          providerSaved: true,
        }),
        { status: 400 },
      ),
  );
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api" }),
    getEnvironmentId: () => "prod",
    origin: "http://localhost:5177",
    fetchImpl,
  });
  const input = {
    provider: "openai" as const,
    model: "fixture-embedding",
    apiKey: "synthetic-embedding-key",
  };
  await expect(
    client.saveRuntimeSetupEmbedding(input, "dev one"),
  ).rejects.toMatchObject({
    message: "The embedding check failed.",
    code: "embedding_probe_failed",
    payload: { providerSaved: true },
  });
  expect(fetchImpl.mock.calls[0]).toEqual([
    "/web-api/runtime/setup/embedding?environment=dev%20one",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
  ]);
  expect(fetchImpl.mock.calls[0][0]).not.toContain(input.apiKey);
  expect(input.apiKey).toBe("synthetic-embedding-key");
});

test("additive model setup scopes requests and preserves credential-save retry evidence", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, providers: [], profileIds: [] })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: "model_setup_failed",
          message: "The model could not be saved.",
          credentialSaved: true,
        }),
        { status: 400 },
      ),
    );
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api" }),
    getEnvironmentId: () => "prod",
    origin: "http://localhost:5177",
    fetchImpl,
  });
  await client.loadModelSetup("dev one");
  expect(fetchImpl.mock.calls[0][0]).toBe(
    "/web-api/runtime/config/models/setup?environment=dev%20one",
  );
  const input = {
    profileId: "extra",
    providerId: "connection",
    model: "fixture",
    apiKey: "synthetic-model-key",
  };
  await expect(client.addRuntimeModel(input, "dev one")).rejects.toMatchObject({
    code: "model_setup_failed",
    payload: { credentialSaved: true },
  });
  expect(fetchImpl.mock.calls[1]).toEqual([
    "/web-api/runtime/config/models?environment=dev%20one",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
  ]);
  expect(fetchImpl.mock.calls[1][0]).not.toContain(input.apiKey);
});
