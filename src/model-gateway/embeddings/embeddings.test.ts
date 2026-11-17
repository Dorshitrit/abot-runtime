import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
} from "../provider-adapter.js";
import type { ModelGatewayPolicyConfig } from "../types.js";
import { discoverEmbeddingModels } from "./discovery.js";
import { executeEmbeddingRequest } from "./execution.js";

const CUSTOM_POLICY: ModelGatewayPolicyConfig = {
  providers: { fixture: { type: "fixture-provider" } },
  embeddingProfiles: {
    memory: { provider: "fixture", model: "fixture-embedding" },
  },
};

function createAdapter(
  overrides: Partial<ModelProviderAdapter> = {},
): ModelProviderAdapter {
  return {
    type: "fixture-provider",
    supportsImageInput: false,
    embed: async (params) => ({
      kind: "embedded",
      modelFingerprint: "sha256:fixture",
      vectors: params.texts.map(() => [0.25, 0.75]),
    }),
    invoke: async () => ({ kind: "raw", body: {} }),
    ...overrides,
  };
}

describe("model gateway embeddings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("routes a validated batch through the configured provider adapter", async () => {
    const embed = vi.fn<NonNullable<ModelProviderAdapter["embed"]>>(
      async (params) => ({
        kind: "embedded",
        modelFingerprint: "sha256:fixture",
        vectors: params.texts.map(() => [0.25, 0.75]),
      }),
    );
    const result = await executeEmbeddingRequest({
      profileId: "memory",
      texts: ["one", "two"],
      modelPolicy: CUSTOM_POLICY,
      abortSignal: new AbortController().signal,
      providerAdapters: createModelProviderAdapterRegistry([
        createAdapter({ embed }),
      ]),
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(result).toEqual({
      profileId: "memory",
      provider: "fixture-provider",
      model: "fixture-embedding",
      modelFingerprint: "sha256:fixture",
      dimensions: 2,
      vectors: [
        [0.25, 0.75],
        [0.25, 0.75],
      ],
    });
  });

  test.each([
    { vectors: [], reason: "model_gateway_embedding_vector_count_invalid" },
    {
      vectors: [[Number.NaN]],
      reason: "model_gateway_embedding_vector_non_finite",
    },
    {
      vectors: [[1], [1, 2]],
      reason: "model_gateway_embedding_dimensions_inconsistent",
    },
  ])(
    "rejects invalid provider vectors: $reason",
    async ({ vectors, reason }) => {
      await expect(
        executeEmbeddingRequest({
          profileId: "memory",
          texts: vectors.length === 2 ? ["one", "two"] : ["one"],
          modelPolicy: CUSTOM_POLICY,
          abortSignal: new AbortController().signal,
          providerAdapters: createModelProviderAdapterRegistry([
            createAdapter({
              embed: async () => ({
                kind: "embedded",
                modelFingerprint: "sha256:fixture",
                vectors,
              }),
            }),
          ]),
        }),
      ).rejects.toThrow(reason);
    },
  );

  test.each(["", " "])(
    "rejects a blank adapter fingerprint: %j",
    async (modelFingerprint) => {
      await expect(
        executeEmbeddingRequest({
          profileId: "memory",
          texts: ["one"],
          modelPolicy: CUSTOM_POLICY,
          abortSignal: new AbortController().signal,
          providerAdapters: createModelProviderAdapterRegistry([
            createAdapter({
              embed: async () => ({
                kind: "embedded",
                modelFingerprint,
                vectors: [[0.25, 0.75]],
              }),
            }),
          ]),
        }),
      ).rejects.toThrow("model_gateway_embedding_binding_invalid");
    },
  );

  test("uses optional provider discovery without inventing a global catalog", async () => {
    const adapters = createModelProviderAdapterRegistry([
      createAdapter({
        listEmbeddingModels: async () => ({
          kind: "listed",
          models: ["z-model", "a-model", "a-model"],
        }),
      }),
    ]);

    await expect(
      discoverEmbeddingModels({
        providerId: "fixture",
        modelPolicy: CUSTOM_POLICY,
        abortSignal: new AbortController().signal,
        providerAdapters: adapters,
      }),
    ).resolves.toEqual({ supported: true, models: ["a-model", "z-model"] });
  });

  test("projects Ollama embedding requests to /api/embed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "nomic-embed-text",
        input: ["hello"],
      });
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), {
        status: 200,
      });
    });
    const result = await executeEmbeddingRequest({
      profileId: "memory",
      texts: ["hello"],
      modelPolicy: {
        providers: {
          local: { type: "ollama", baseUrl: "http://ollama.test/" },
        },
        embeddingProfiles: {
          memory: { provider: "local", model: "nomic-embed-text" },
        },
      },
      abortSignal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://ollama.test/api/embed");
    expect(result.dimensions).toBe(3);
  });

  test("lists only Ollama models declaring embedding support and separates missing capability metadata", async () => {
    const names = ["dual", "chat", "legacy", "unavailable", "chat"];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (url === "http://ollama.test/api/tags")
        return Response.json({ models: names.map((name) => ({ name })) });
      expect(url).toBe("http://ollama.test/api/show");
      expect(init?.method).toBe("POST");
      const { model } = JSON.parse(String(init?.body));
      if (model === "unavailable") return new Response(null, { status: 404 });
      if (model === "legacy") return Response.json({});
      return Response.json({ capabilities: model === "dual" ? ["completion", "embedding"] : ["completion"] });
    });

    await expect(
      discoverEmbeddingModels({
        providerId: "local",
        modelPolicy: {
          providers: {
            local: { type: "ollama", baseUrl: "http://ollama.test/" },
          },
        },
        abortSignal: new AbortController().signal,
        fetchImpl,
      }),
    ).resolves.toEqual({
      supported: true,
      models: ["dual"],
      unverifiedModels: ["legacy", "unavailable"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  test("cancels model metadata inspection before starting another batch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/api/tags"))
        return Response.json({ models: Array.from({ length: 12 }, (_, i) => ({ name: `m${i}` })) });
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("request cancellation was not propagated");
    });
    await expect(discoverEmbeddingModels({
      providerId: "local",
      modelPolicy: { providers: { local: { type: "ollama" } } },
      abortSignal: controller.signal, fetchImpl,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl.mock.calls.length).toBeLessThan(13);
  });

  test("preserves installed IDs as unverified after the shared metadata deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const names = Array.from({ length: 6 }, (_, index) => `m${index}`);
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/api/tags"))
        return Response.json({ models: names.map((name) => ({ name })) });
      deadline.abort(new DOMException("Metadata timed out", "TimeoutError"));
      init?.signal?.throwIfAborted();
      return Response.json({ capabilities: ["embedding"] });
    });
    try {
      await expect(discoverEmbeddingModels({
        providerId: "local",
        modelPolicy: { providers: { local: { type: "ollama" } } },
        abortSignal: new AbortController().signal, fetchImpl,
      })).resolves.toEqual({ supported: true, models: [], unverifiedModels: names });
      expect(fetchImpl.mock.calls.length).toBeLessThan(names.length + 1);
    } finally {
      timeout.mockRestore();
    }
  });

  test("includes the effective Ollama endpoint in the vector fingerprint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 }),
    );
    const request = () =>
      executeEmbeddingRequest({
        profileId: "memory",
        texts: ["hello"],
        modelPolicy: {
          providers: { local: { type: "ollama" } },
          embeddingProfiles: {
            memory: { provider: "local", model: "nomic-embed-text" },
          },
        },
        abortSignal: new AbortController().signal,
        fetchImpl,
      });

    vi.stubEnv("OLLAMA_URL", "http://ollama-one.test");
    const first = await request();
    vi.stubEnv("OLLAMA_URL", "http://ollama-two.test");
    const second = await request();

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://ollama-one.test/api/embed",
      "http://ollama-two.test/api/embed",
    ]);
    expect(first.modelFingerprint).not.toBe(second.modelFingerprint);
  });

  test("projects OpenAI embedding requests to /embeddings", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-secret");
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        dimensions: 2,
        model: "consumer-choice",
        input: ["hello"],
        encoding_format: "float",
      });
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] }),
        { status: 200 },
      );
    });
    await executeEmbeddingRequest({
      profileId: "memory",
      texts: ["hello"],
      modelPolicy: {
        providers: {
          cloud: { type: "openai", baseUrl: "https://openai.test/v1" },
        },
        embeddingProfiles: {
          memory: {
            provider: "cloud",
            model: "consumer-choice",
            options: {
              dimensions: 2,
              encoding_format: "base64",
              model: "untrusted-override",
              input: ["untrusted-override"],
            },
          },
        },
      },
      abortSignal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://openai.test/v1/embeddings",
    );
  });

  test("includes the effective OpenAI endpoint in the vector fingerprint", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-secret");
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] }),
          { status: 200 },
        ),
    );
    const request = () =>
      executeEmbeddingRequest({
        profileId: "memory",
        texts: ["hello"],
        modelPolicy: {
          providers: { cloud: { type: "openai" } },
          embeddingProfiles: {
            memory: { provider: "cloud", model: "text-embedding" },
          },
        },
        abortSignal: new AbortController().signal,
        fetchImpl,
      });

    vi.stubEnv("OPENAI_BASE_URL", "https://openai-one.test/v1");
    const first = await request();
    vi.stubEnv("OPENAI_BASE_URL", "https://openai-two.test/v1");
    const second = await request();

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://openai-one.test/v1/embeddings",
      "https://openai-two.test/v1/embeddings",
    ]);
    expect(first.modelFingerprint).not.toBe(second.modelFingerprint);
  });

  test("rejects duplicate OpenAI embedding indices", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-secret");
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(
      executeEmbeddingRequest({
        profileId: "memory",
        texts: ["first", "second"],
        modelPolicy: {
          providers: {
            cloud: { type: "openai", baseUrl: "https://openai.test/v1" },
          },
          embeddingProfiles: {
            memory: { provider: "cloud", model: "text-embedding" },
          },
        },
        abortSignal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow("model_gateway_embedding_vector_count_invalid");
  });
});
