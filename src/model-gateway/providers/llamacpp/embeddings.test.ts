import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";

import { discoverEmbeddingModels } from "../../embeddings/discovery.js";
import { executeEmbeddingRequest } from "../../embeddings/execution.js";
import type { ModelGatewayPolicyConfig } from "../../types.js";

function policy(baseUrl = "http://embedding.test", provider = "llamacpp"): ModelGatewayPolicyConfig {
  return {
    providers: { local: { type: provider, baseUrl } },
    embeddingProfiles: { memory: { provider: "local", model: "embedding-model" } },
  };
}

function embed(
  fetchImpl: typeof fetch,
  modelPolicy = policy(),
  texts: readonly string[] = ["first", "second"],
  abortSignal = new AbortController().signal,
) {
  return executeEmbeddingRequest({ profileId: "memory", texts, modelPolicy, abortSignal, fetchImpl });
}

function response(data: unknown = [
  { index: 1, embedding: [0, 1] },
  { index: 0, embedding: [1, 0] },
]): Response {
  return Response.json({ data });
}

afterEach(() => vi.unstubAllEnvs());

describe("llama.cpp embedding transport", () => {
  test.each(["http://embedding.test", "http://embedding.test/v1/"])(
    "uses the embedding API and owns input/model/encoding fields for %s",
    async (baseUrl) => {
      vi.stubEnv("OPENAI_API_KEY", "must-not-be-used");
      const modelPolicy = policy(baseUrl);
      modelPolicy.embeddingProfiles!.memory!.options = {
        dimensions: 2, model: "untrusted", input: ["untrusted"], encoding_format: "base64",
      };
      const fetchImpl = vi.fn<typeof fetch>(async () => response());
      const result = await embed(fetchImpl, modelPolicy);
      expect(fetchImpl).toHaveBeenCalledWith("http://embedding.test/v1/embeddings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dimensions: 2, model: "embedding-model", input: ["first", "second"], encoding_format: "float",
        }),
        signal: expect.any(AbortSignal),
      });
      expect(result).toMatchObject({
        profileId: "memory", provider: "llamacpp", model: "embedding-model",
        dimensions: 2, vectors: [[1, 0], [0, 1]],
      });
      expect(result.modelFingerprint).toMatch(/^llamacpp:embedding-model:[a-f0-9]{24}$/);
    },
  );

  test("uses only the explicitly configured optional credential", async () => {
    vi.stubEnv("LLAMACPP_EMBED_TEST_KEY", "fixture-secret");
    const modelPolicy = policy();
    modelPolicy.providers!.local!.apiKeyEnv = "LLAMACPP_EMBED_TEST_KEY";
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    await embed(fetchImpl, modelPolicy);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json", Authorization: "Bearer fixture-secret",
    });
  });

  test.each([
    { baseUrl: "", apiKeyEnv: undefined, reason: "llamacpp_base_url_required" },
    { baseUrl: "ftp://embedding.test", apiKeyEnv: undefined, reason: "llamacpp_base_url_invalid" },
    { baseUrl: "http://embedding.test", apiKeyEnv: "BAD-ENV", reason: "llamacpp_api_key_env_invalid" },
    { baseUrl: "http://embedding.test", apiKeyEnv: "LLAMACPP_EMBED_MISSING", reason: "missing llama.cpp API key env: LLAMACPP_EMBED_MISSING" },
  ])("rejects configuration before fetching: $reason", async ({ baseUrl, apiKeyEnv, reason }) => {
    vi.stubEnv("LLAMACPP_EMBED_MISSING", "");
    const modelPolicy = policy(baseUrl);
    modelPolicy.providers!.local!.apiKeyEnv = apiKeyEnv;
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(embed(fetchImpl, modelPolicy)).rejects.toMatchObject({ statusCode: 500, message: reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fingerprints the normalized endpoint, model and options", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const original = await embed(fetchImpl);
    const same = await embed(fetchImpl, policy("http://embedding.test/v1/"));
    const moved = await embed(fetchImpl, policy("http://other.test"));
    const changedModel = policy();
    changedModel.embeddingProfiles!.memory!.model = "other-embedding-model";
    const changedOptions = policy();
    changedOptions.embeddingProfiles!.memory!.options = { dimensions: 2 };
    expect(same.modelFingerprint).toBe(original.modelFingerprint);
    expect(moved.modelFingerprint).not.toBe(original.modelFingerprint);
    expect((await embed(fetchImpl, changedModel)).modelFingerprint).not.toBe(original.modelFingerprint);
    expect((await embed(fetchImpl, changedOptions)).modelFingerprint).not.toBe(original.modelFingerprint);
  });

  test.each([401, 429, 503])("preserves upstream HTTP status %i", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("provider rejected embeddings", { status }));
    await expect(embed(fetchImpl)).rejects.toMatchObject({ statusCode: status, message: "provider rejected embeddings" });
  });

  test("supplies a readable fallback for an empty provider failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 502 }));
    await expect(embed(fetchImpl)).rejects.toMatchObject({ statusCode: 502, message: "llamacpp embedding error" });
  });

  test("preserves fetch failures", async () => {
    const failure = new TypeError("fixture network failure");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
    await expect(embed(fetchImpl)).rejects.toBe(failure);
  });

  test("rejects malformed JSON and extra malformed records", async () => {
    await expect(embed(vi.fn<typeof fetch>(async () => new Response("not json"))))
      .rejects.toThrow("model_gateway_embedding_vector_count_invalid");
    await expect(embed(vi.fn<typeof fetch>(async () => response([
      { index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }, null,
    ])))).rejects.toThrow("model_gateway_embedding_vector_count_invalid");
  });

  test("keeps model discovery unsupported without making a model-list request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(discoverEmbeddingModels({
      providerId: "local", modelPolicy: policy(), abortSignal: new AbortController().signal, fetchImpl,
    })).resolves.toEqual({ supported: false, models: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("an already cancelled request never reaches the provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(embed(fetchImpl, policy(), ["first"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("cancellation stops an active HTTP response body and preserves AbortError", async () => {
    let markBodyStarted!: () => void;
    let markClosed!: () => void;
    const started = new Promise<void>((resolve) => { markBodyStarted = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const provider = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.on("close", markClosed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"data":[');
      });
    });
    const controller = new AbortController();
    try {
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("test port unavailable");
      const fetchImpl: typeof fetch = async (input, init) => {
        const received = await fetch(input, init);
        markBodyStarted();
        return received;
      };
      const result = embed(fetchImpl, policy(`http://127.0.0.1:${address.port}`), ["first"], controller.signal);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
      await closed;
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => {
        provider.close(() => resolve());
        provider.closeAllConnections();
      });
    }
  });
});

describe.each(["llamacpp", "openai"])("%s compatible embedding response parity", (provider) => {
  test("orders vectors by response index", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-secret");
    const result = await embed(vi.fn<typeof fetch>(async () => response()), policy("http://embedding.test/v1", provider));
    expect(result.vectors).toEqual([[1, 0], [0, 1]]);
  });

  test.each([
    { label: "missing data", data: undefined, reason: "vector_count_invalid" },
    { label: "missing vector", data: [{ index: 0, embedding: [1, 0] }], reason: "vector_count_invalid" },
    { label: "duplicate index", data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [0] }], reason: "vector_count_invalid" },
    { label: "out of range index", data: [{ index: 0, embedding: [1] }, { index: 2, embedding: [0] }], reason: "vector_count_invalid" },
    { label: "negative index", data: [{ index: -1, embedding: [1] }, { index: 1, embedding: [0] }], reason: "vector_count_invalid" },
    { label: "fractional index", data: [{ index: 0.5, embedding: [1] }, { index: 1, embedding: [0] }], reason: "vector_count_invalid" },
    { label: "string index", data: [{ index: "0", embedding: [1] }, { index: 1, embedding: [0] }], reason: "vector_count_invalid" },
    { label: "empty vector", data: [{ index: 0, embedding: [] }, { index: 1, embedding: [0] }], reason: "vector_invalid" },
    { label: "inconsistent dimensions", data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [0, 1] }], reason: "dimensions_inconsistent" },
    { label: "nonnumeric value", data: [{ index: 0, embedding: ["1"] }, { index: 1, embedding: [0] }], reason: "vector_non_finite" },
    { label: "token vectors", data: [{ index: 0, embedding: [[1, 0]] }, { index: 1, embedding: [[0, 1]] }], reason: "vector_non_finite" },
  ])("rejects $label", async ({ data, reason }) => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-secret");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data }));
    await expect(embed(fetchImpl, policy("http://embedding.test/v1", provider)))
      .rejects.toThrow(`model_gateway_embedding_${reason}`);
  });

  test.each(["null", "1e400", "-1e400"])("rejects nonfinite JSON value %s", async (numeric) => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-secret");
    // An overflowing JSON number can parse to Infinity without malformed JSON.
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      `{"data":[{"index":0,"embedding":[${numeric}]},{"index":1,"embedding":[0]}]}`,
    ));
    await expect(embed(fetchImpl, policy("http://embedding.test/v1", provider)))
      .rejects.toThrow("model_gateway_embedding_vector_non_finite");
  });
});
