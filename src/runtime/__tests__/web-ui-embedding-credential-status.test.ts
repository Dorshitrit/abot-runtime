import { afterEach, describe, expect, test, vi } from "vitest";
import { createEmbeddingCredentialStatus } from "../../web-ui/app/components/runtime-setup/embedding-credential-status.js";
import { createRuntimeOnboardingFeature } from "../../web-ui/app/runtime-onboarding-feature.js";
import * as setupGuide from "../../web-ui/app/components/runtime-setup-guide.js";
import type { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

type EmbeddingInput = Parameters<
  ReturnType<typeof createRuntimeWebClient>["saveRuntimeSetupEmbedding"]
>[0];
const statusPayload = () => ({
  status: { enabled: false, providers: [{ id: "cloud", type: "openai" }] },
});
function fixture() {
  let environment = "first";
  const runtimeClient = {
    loadLongTermMemoryStatus: vi.fn(
      async (_environment?: string): Promise<Record<string, unknown>> =>
        statusPayload(),
    ),
    loadModelSetup: vi.fn(
      async (_environment?: string): Promise<Record<string, unknown>> => ({
        providers: [
          { id: "cloud", type: "openai", credentialConfigured: true },
        ],
      }),
    ),
    saveRuntimeSetupEmbedding: vi.fn(
      async (
        _input: EmbeddingInput,
        _environment?: string,
      ): Promise<Record<string, unknown>> => statusPayload(),
    ),
  };
  const embedding = createEmbeddingCredentialStatus({
    runtimeClient,
    getEnvironmentId: () => environment,
  });
  return {
    runtimeClient,
    embedding,
    setEnvironment: (value: string) => {
      environment = value;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("embedding credential metadata", () => {
  test("projects only a strict boolean for the exact provider identity without mutating source status", async () => {
    const current = fixture();
    const payload = {
      status: {
        enabled: false,
        providers: [
          Object.freeze({ id: "cloud", type: "openai" }),
          { id: "other", type: "openai" },
          { id: "cloud", type: "ollama" },
          { id: "string-flag", type: "openai" },
        ],
      },
    };
    current.runtimeClient.loadLongTermMemoryStatus.mockResolvedValue(payload);
    current.runtimeClient.loadModelSetup.mockResolvedValue({
      providers: [
        {
          id: "cloud",
          type: "openai",
          credentialConfigured: true,
          apiKey: "must-never-copy",
        },
        { id: "string-flag", type: "openai", credentialConfigured: "true" },
      ],
    });
    const result = await current.embedding.loadStatus();
    expect(result).toEqual({
      status: {
        enabled: false,
        providers: [
          { id: "cloud", type: "openai", credentialConfigured: true },
          { id: "other", type: "openai" },
          { id: "cloud", type: "ollama" },
          { id: "string-flag", type: "openai", credentialConfigured: false },
        ],
      },
    });
    expect(payload.status.providers[0]).not.toHaveProperty(
      "credentialConfigured",
    );
    expect(JSON.stringify(result)).not.toContain("must-never-copy");
  });

  test("catalog failure omits stale metadata without blocking the memory status", async () => {
    const current = fixture();
    current.runtimeClient.loadLongTermMemoryStatus.mockResolvedValue({
      status: {
        enabled: true,
        providers: [
          { id: "cloud", type: "openai", credentialConfigured: true },
        ],
      },
    });
    current.runtimeClient.loadModelSetup.mockRejectedValue(
      new Error("catalog offline"),
    );
    expect(await current.embedding.loadStatus()).toEqual({
      status: { enabled: true, providers: [{ id: "cloud", type: "openai" }] },
    });
  });

  test("loads fresh credential metadata after a successful embedding save", async () => {
    const current = fixture();
    current.runtimeClient.saveRuntimeSetupEmbedding.mockImplementation(
      async () => {
        expect(current.runtimeClient.loadModelSetup).not.toHaveBeenCalled();
        return { ...statusPayload(), probe: { dimensions: 16 } };
      },
    );
    const input = { providerId: "cloud", model: "embedding-model" };
    expect(await current.embedding.saveEmbedding(input)).toMatchObject({
      status: {
        providers: [
          { id: "cloud", type: "openai", credentialConfigured: true },
        ],
      },
      probe: { dimensions: 16 },
    });
    expect(
      current.runtimeClient.saveRuntimeSetupEmbedding,
    ).toHaveBeenCalledWith(input, "first");
    expect(current.runtimeClient.loadModelSetup).toHaveBeenCalledWith("first");
  });

  test("returns successful embedding saves even when optional credential lookup fails", async () => {
    const current = fixture();
    current.runtimeClient.loadModelSetup.mockRejectedValue(
      new Error("unavailable"),
    );
    expect(
      await current.embedding.saveEmbedding({
        providerId: "cloud",
        model: "embedding-model",
      }),
    ).toEqual(statusPayload());
  });

  test("enriches a partial-save receipt from the catalog and rethrows the same error", async () => {
    const current = fixture();
    const failure = {
      payload: {
        error: "embedding_setup_failed",
        message: "Model check failed",
        providerSaved: true,
        savedProvider: { id: "cloud", type: "openai" },
      },
    };
    current.runtimeClient.saveRuntimeSetupEmbedding.mockRejectedValue(failure);
    await expect(
      current.embedding.saveEmbedding({
        providerId: "cloud",
        model: "bad-model",
      }),
    ).rejects.toBe(failure);
    expect(failure.payload).toMatchObject({
      error: "embedding_setup_failed",
      message: "Model check failed",
      savedProvider: {
        id: "cloud",
        type: "openai",
        credentialConfigured: true,
      },
    });
  });

  test("cannot infer a saved key from a provider-save receipt when the lookup fails", async () => {
    const current = fixture();
    const failure = {
      payload: {
        providerSaved: true,
        savedProvider: { id: "cloud", type: "openai" },
      },
    };
    current.runtimeClient.loadModelSetup.mockRejectedValue(
      new Error("offline"),
    );
    current.runtimeClient.saveRuntimeSetupEmbedding.mockRejectedValue(failure);
    await expect(
      current.embedding.saveEmbedding({
        providerId: "cloud",
        model: "bad-model",
      }),
    ).rejects.toBe(failure);
    expect(failure.payload.savedProvider).not.toHaveProperty(
      "credentialConfigured",
    );
  });

  test("preserves frozen errors and ordinary failures without replacing their identity", async () => {
    const current = fixture();
    const frozen = Object.freeze({
      payload: Object.freeze({
        providerSaved: true,
        savedProvider: Object.freeze({ id: "cloud", type: "openai" }),
      }),
    });
    current.runtimeClient.saveRuntimeSetupEmbedding.mockRejectedValueOnce(
      frozen,
    );
    await expect(
      current.embedding.saveEmbedding({
        providerId: "cloud",
        model: "bad-model",
      }),
    ).rejects.toBe(frozen);
    current.runtimeClient.loadModelSetup.mockClear();
    const failure = new Error("request failed");
    current.runtimeClient.saveRuntimeSetupEmbedding.mockRejectedValueOnce(
      failure,
    );
    await expect(
      current.embedding.saveEmbedding({
        providerId: "cloud",
        model: "bad-model",
      }),
    ).rejects.toBe(failure);
    expect(current.runtimeClient.loadModelSetup).not.toHaveBeenCalled();
  });

  test("captures the environment before an operation and decorates its own response after a switch", async () => {
    const current = fixture();
    const pending = deferred<Record<string, unknown>>();
    current.runtimeClient.saveRuntimeSetupEmbedding.mockReturnValue(
      pending.promise,
    );
    const save = current.embedding.saveEmbedding({
      providerId: "cloud",
      model: "embedding-model",
    });
    current.setEnvironment("second");
    pending.resolve(statusPayload());
    await save;
    expect(current.runtimeClient.loadModelSetup).toHaveBeenCalledWith("first");
    await current.embedding.loadStatus();
    expect(
      current.runtimeClient.loadLongTermMemoryStatus,
    ).toHaveBeenLastCalledWith("second");
    expect(current.runtimeClient.loadModelSetup).toHaveBeenLastCalledWith(
      "second",
    );
  });

  test("feature composition decorates both the guide status and save callbacks", async () => {
    const current = fixture();
    let options: setupGuide.RuntimeSetupGuideDependencies | undefined;
    vi.spyOn(setupGuide, "createRuntimeSetupGuide").mockImplementation(
      (value) => {
        options = value;
        return {
          bind: vi.fn(),
          render: vi.fn(),
          clearSecret: vi.fn(),
          dispose: vi.fn(),
          focusAction: vi.fn(),
        };
      },
    );
    const feature = createRuntimeOnboardingFeature({
      dom: {
        runtimeSetupGuide: {} as HTMLElement,
        messagesList: {} as HTMLElement,
      },
      runtimeClient: {
        ...current.runtimeClient,
        getRuntimeSetup: async () => ({}),
        saveRuntimeSetup: async () => ({}),
        applyRuntimeConfiguration: async () => ({}),
        discoverLongTermMemoryModels: async () => ({}),
        getRuntimePlugins: async () => ({}),
        setRuntimePlugin: async () => ({}),
      },
      selectedEnvironmentId: () => "selected",
      state: {
        config: { backend: "runtime" },
        runtimeAvailability: { status: "loading" },
      },
      reloadModels: vi.fn(),
      reloadCatalog: vi.fn(),
      setMessageStatus: vi.fn(),
    });
    feature.guide.render({ status: "setup_required" });
    expect(await options!.loadEmbeddingStatus()).toMatchObject({
      status: { providers: [{ credentialConfigured: true }] },
    });
    expect(
      await options!.saveEmbedding({
        providerId: "cloud",
        model: "embedding-model",
      }),
    ).toMatchObject({
      status: { providers: [{ credentialConfigured: true }] },
    });
    expect(current.runtimeClient.loadModelSetup).toHaveBeenCalledTimes(2);
    expect(
      current.runtimeClient.saveRuntimeSetupEmbedding,
    ).toHaveBeenCalledWith(
      { providerId: "cloud", model: "embedding-model" },
      "selected",
    );
  });
});
