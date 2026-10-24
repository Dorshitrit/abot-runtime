import { describe, expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function clientFixture(payload: unknown = { ok: true }, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json(payload, { status }),
  );
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api", backend: "runtime" }),
    getEnvironmentId: () => "prod",
    origin: "http://localhost:5177",
    fetchImpl,
  });
  return { client, fetchImpl };
}

describe("Memory settings connection client", () => {
  test("posts the exact connection and memory options to the selected environment without changing the input", async () => {
    const { client, fetchImpl } = clientFixture();
    const input = Object.freeze({
      provider: "llamacpp" as const,
      newProviderId: "llamacpp-embedding",
      model: "fixture-embedding",
      baseUrl: "http://127.0.0.1:8081",
      useApiKey: true,
      apiKey: "synthetic-client-key",
      profileId: "memory-custom",
      emitClientEvents: false,
    });
    await client.saveMemoryEmbeddingConnection(input, "dev /&");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "/web-api/runtime/memory/connection?environment=dev%20%2F%26",
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  test("retains the canonical saved-provider failure receipt for the caller", async () => {
    const receipt = {
      ok: false,
      error: "embedding_setup_failed",
      message: "Embedding check failed.",
      providerSaved: true,
      savedProvider: { id: "llamacpp-embedding", type: "llamacpp" },
    };
    const { client, fetchImpl } = clientFixture(receipt, 400);
    await expect(
      client.saveMemoryEmbeddingConnection({
        providerId: "llamacpp-embedding",
        model: "fixture-embedding",
      }),
    ).rejects.toMatchObject({ status: 400, payload: receipt });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "/web-api/runtime/memory/connection?environment=prod",
    );
  });
});
