import { describe, expect, test, vi } from "vitest";
import type { SetupEmbeddingInput } from "../../web-ui/local-runtime/setup-embedding-input.js";
import { createEmbeddingCredentialStatus } from "../../web-ui/app/components/runtime-setup/embedding-credential-status.js";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

const savedSetup = {
  ...setupSnapshot,
  status: "ready" as const,
  existingModel: { provider: "ollama" as const, model: "chat-model" },
};
const providers = [
  {
    id: "llamacpp",
    type: "llamacpp",
    credentialConfigured: true,
    requiresApiKey: true,
  },
  {
    id: "llamacpp-embedding",
    type: "llamacpp",
    credentialConfigured: false,
    requiresApiKey: false,
  },
];
function harness(overrides: Parameters<typeof createGuideHarness>[0] = {}) {
  return createGuideHarness({
    loadSetup: async () => ({ setup: savedSetup }),
    loadEmbeddingStatus: async () => ({
      status: { enabled: false, providers },
    }),
    ...overrides,
  });
}
const success = (providerId: string) => ({
  status: {
    enabled: true,
    providerId,
    model: "embed-model",
    providers: [...providers, { id: providerId, type: "llamacpp" }],
  },
});
const failedProbe = (id = "llamacpp-embedding-2") =>
  Object.assign(new Error("private upstream error"), {
    payload: {
      providerSaved: true,
      savedProvider: {
        id,
        type: "llamacpp",
        credentialConfigured: true,
        requiresApiKey: true,
      },
      message: "Embedding probe failed.",
    },
  });

describe("llama.cpp embedding connection UI", () => {
  test("offers a separate llama server when one already exists, with explicit identity and no discovery", async () => {
    const requests: SetupEmbeddingInput[] = [];
    const h = harness({
      saveEmbedding: async (input) => {
        requests.push({ ...input });
        return success(input.newProviderId!);
      },
    });
    await h.open();
    expect(h.container.innerHTML).toContain('value="new:llamacpp"');
    expect(h.container.innerHTML).not.toContain(
      'data-runtime-setup-action="embedding-discover"',
    );
    h.click("embedding-discover");
    expect(h.discoverEmbeddingModels).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    h.changeEmbeddingProvider("new:llamacpp");
    expect(h.fields["embedding-connection-id"].value).toBe(
      "llamacpp-embedding-2",
    );
    expect(h.fields["embedding-url"].value).toBe("http://127.0.0.1:8080");
    h.inputEmbeddingConnectionId("dedicated-embeddings");
    h.inputEmbeddingBaseUrl("http://127.0.0.1:18082");
    h.inputEmbeddingModel("embed-model");
    h.inputEmbeddingKey("synthetic-private-embedding-key");
    h.submit();
    await h.ready();
    expect(requests).toEqual([
      {
        provider: "llamacpp",
        newProviderId: "dedicated-embeddings",
        useApiKey: true,
        baseUrl: "http://127.0.0.1:18082",
        model: "embed-model",
        apiKey: "synthetic-private-embedding-key",
      },
    ]);
    expect(h.container.innerHTML).toContain("Choose your plugins");
    expect(h.container.innerHTML).not.toContain(
      "synthetic-private-embedding-key",
    );
  });

  test("creates no-auth connections explicitly and validates identity and origin before Test and Save", async () => {
    const saveEmbedding = vi.fn(async () => success("llamacpp-embedding-2"));
    const h = harness({ saveEmbedding });
    await h.open();
    h.changeEmbeddingProvider("new:llamacpp");
    h.inputEmbeddingModel("embed-model");
    h.inputEmbeddingConnectionId("bad/id");
    h.submit();
    await h.ready();
    expect(saveEmbedding).not.toHaveBeenCalled();
    h.inputEmbeddingConnectionId("llamacpp-embedding-2");
    h.inputEmbeddingBaseUrl("http://server:8080/v1");
    h.submit();
    await h.ready();
    expect(saveEmbedding).not.toHaveBeenCalled();
    h.inputEmbeddingBaseUrl("http://server:8080");
    h.submit();
    await h.ready();
    expect(saveEmbedding).toHaveBeenCalledWith({
      provider: "llamacpp",
      newProviderId: "llamacpp-embedding-2",
      useApiKey: false,
      model: "embed-model",
      baseUrl: "http://server:8080",
    });
  });

  test("failed probes select the saved receipt and retry without another connection or retained secret", async () => {
    const requests: SetupEmbeddingInput[] = [];
    const references: SetupEmbeddingInput[] = [];
    const h = harness({
      saveEmbedding: async (input) => {
        requests.push({ ...input });
        references.push(input);
        if (requests.length === 1) throw failedProbe();
        return success(input.providerId!);
      },
    });
    await h.open();
    h.changeEmbeddingProvider("new:llamacpp");
    h.inputEmbeddingModel("embed-model");
    h.inputEmbeddingKey("synthetic-private-embedding-key");
    h.submit();
    await h.ready();
    expect(h.container.innerHTML).toContain(
      'value="llamacpp-embedding-2" selected',
    );
    expect(h.container.innerHTML).toContain("API key already saved");
    expect(h.fields["embedding-key"].value).toBe("");
    expect(references[0]).not.toHaveProperty("apiKey");
    h.submit();
    await h.ready();
    expect(requests[1]).toEqual({
      providerId: "llamacpp-embedding-2",
      model: "embed-model",
    });
  });

  test("a mismatched receipt cannot redirect an explicit new connection identity", async () => {
    const requests: SetupEmbeddingInput[] = [];
    const h = harness({
      saveEmbedding: async (input) => {
        requests.push({ ...input });
        throw failedProbe("different-connection");
      },
    });
    await h.open();
    h.changeEmbeddingProvider("new:llamacpp");
    h.inputEmbeddingModel("embed-model");
    h.inputEmbeddingKey("synthetic-private-embedding-key");
    h.submit();
    await h.ready();
    expect(h.container.innerHTML).toContain('value="new:llamacpp" selected');
    h.submit();
    await h.ready();
    expect(requests[1]).toMatchObject({
      newProviderId: "llamacpp-embedding-2",
      useApiKey: true,
    });
    expect(requests[1]).not.toHaveProperty("apiKey");
  });

  test("saved no-auth selection hides authentication input and keeps existing memory without probing", async () => {
    const h = harness({
      loadEmbeddingStatus: async () => ({
        status: {
          enabled: true,
          providerId: "llamacpp-embedding",
          model: "embed-model",
          providers,
        },
      }),
    });
    await h.open();
    expect(h.container.innerHTML).not.toContain(
      'data-runtime-setup-field="embedding-key"',
    );
    expect(h.container.innerHTML).not.toContain(
      'data-runtime-setup-field="embedding-url"',
    );
    h.submit();
    await h.ready();
    expect(h.saveEmbedding).not.toHaveBeenCalled();
    expect(h.container.innerHTML).toContain("Choose your plugins");
  });

  test("credential status projects only safe binding flags for llama.cpp", async () => {
    const status = createEmbeddingCredentialStatus({
      getEnvironmentId: () => "prod",
      runtimeClient: {
        loadLongTermMemoryStatus: async () => ({
          status: {
            enabled: false,
            providers: [{ id: "embedding", type: "llamacpp" }],
          },
        }),
        loadModelSetup: async () => ({
          providers: [
            {
              id: "embedding",
              type: "llamacpp",
              requiresApiKey: true,
              credentialConfigured: false,
            },
          ],
        }),
        saveRuntimeSetupEmbedding: async () => ({}),
      } as never,
    });
    expect(await status.loadStatus()).toMatchObject({
      status: {
        providers: [
          {
            id: "embedding",
            type: "llamacpp",
            requiresApiKey: true,
            credentialConfigured: false,
          },
        ],
      },
    });
  });
});
