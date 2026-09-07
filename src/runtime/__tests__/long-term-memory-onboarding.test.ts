import { isDeepStrictEqual } from "node:util";
import { describe, expect, test, vi } from "vitest";

import type { RuntimeConfigFile } from "../config/types.js";
import type { LongTermMemoryOnboardingConfigRepository } from "../long-term-memory/onboarding/contracts.js";
import { buildEnabledMemoryConfig } from "../long-term-memory/onboarding/configuration.js";
import { createLongTermMemoryOnboardingService } from "../long-term-memory/onboarding/service.js";

const CONFIG_PATH = "/fixture/runtime.config.json";
const BASE_MODELS = {
  providers: {
    local: { type: "ollama", baseUrl: "http://ollama.test" },
  },
  profiles: {
    chat: {
      provider: "local",
      model: "chat-model",
      contextWindowTokens: 32_768,
    },
  },
};
const BASE_CONFIG: RuntimeConfigFile = {
  models: BASE_MODELS,
  requestRunner: { configRef: "./request-runner.config.json" },
};

describe("long-term memory onboarding", () => {
  test("probes the candidate profile before atomically enabling memory", async () => {
    const harness = createRepositoryHarness(BASE_CONFIG);
    const probe = vi.fn(async () => ({
      modelFingerprint: "sha256:embedding",
      dimensions: 768,
    }));
    const service = createLongTermMemoryOnboardingService({
      repository: harness.repository,
      probe,
      discover: vi.fn(),
    });

    const result = await service.enable({
      providerId: "local",
      model: "consumer-selected-embedding",
      emitClientEvents: true,
    });

    expect(probe).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledWith(expect.any(Object), BASE_CONFIG);
    expect(harness.current()).toMatchObject({
      models: {
        embeddingProfiles: {
          "memory-embedding": {
            provider: "local",
            model: "consumer-selected-embedding",
          },
        },
      },
      longTermMemory: {
        enabled: true,
        emitClientEvents: true,
        embeddingProfileId: "memory-embedding",
      },
    });
    expect(result).toMatchObject({
      restartRequired: true,
      probe: { dimensions: 768 },
      status: { enabled: true, providerId: "local" },
    });
  });

  test.each([
    { providerId: "local", model: "embedding-model", limit: 2 },
    { providerId: "other", model: "embedding-model", limit: 7 },
    { providerId: "local", model: "replacement-model", limit: 7 },
  ])(
    "preserves recall limit $limit when enabling $providerId/$model",
    async ({ providerId, model, limit }) => {
      const harness = createRepositoryHarness({
        ...BASE_CONFIG,
        models: {
          ...BASE_MODELS,
          providers: {
            ...BASE_MODELS.providers,
            other: { type: "ollama", baseUrl: "http://other.test" },
          },
          embeddingProfiles: {
            "memory-embedding": { provider: "local", model: "embedding-model" },
          },
        },
        longTermMemory: {
          enabled: true,
          embeddingProfileId: "memory-embedding",
          maxRecallCallsPerRequest: limit,
        },
      });
      const service = createLongTermMemoryOnboardingService({
        repository: harness.repository,
        probe: vi.fn(async () => ({
          modelFingerprint: "embedding",
          dimensions: 512,
        })),
        discover: vi.fn(),
      });

      await service.enable({ providerId, model });

      expect(harness.current().longTermMemory).toEqual({
        enabled: true,
        emitClientEvents: false,
        embeddingProfileId: "memory-embedding",
        maxRecallCallsPerRequest: limit,
      });
    },
  );

  test("does not modify configuration when the embedding probe fails", async () => {
    const harness = createRepositoryHarness(BASE_CONFIG);
    const service = createLongTermMemoryOnboardingService({
      repository: harness.repository,
      probe: vi.fn(async () => {
        throw new Error("embedding_probe_failed");
      }),
      discover: vi.fn(),
    });

    await expect(
      service.enable({ providerId: "local", model: "broken-model" }),
    ).rejects.toThrow("embedding_probe_failed");
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.current()).toEqual(BASE_CONFIG);
  });

  test("preserves options when re-enabling the same exact embedding target", async () => {
    const configured: RuntimeConfigFile = {
      ...BASE_CONFIG,
      models: {
        ...BASE_MODELS,
        embeddingProfiles: {
          "memory-embedding": {
            provider: "local",
            model: "embedding-model",
            options: { dimensions: 512 },
          },
        },
      },
    };
    const harness = createRepositoryHarness(configured);
    const probe = vi.fn(async () => ({
      modelFingerprint: "sha256:embedding",
      dimensions: 512,
    }));
    const service = createLongTermMemoryOnboardingService({
      repository: harness.repository,
      probe,
      discover: vi.fn(),
    });

    await service.enable({
      providerId: "local",
      model: "embedding-model",
    });

    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPolicy: expect.objectContaining({
          embeddingProfiles: expect.objectContaining({
            "memory-embedding": expect.objectContaining({
              options: { dimensions: 512 },
            }),
          }),
        }),
      }),
    );
    expect(harness.current()).toMatchObject({
      models: {
        embeddingProfiles: {
          "memory-embedding": {
            provider: "local",
            model: "embedding-model",
            options: { dimensions: 512 },
          },
        },
      },
    });
  });

  test.each([
    { providerId: "other", model: "embedding-model" },
    { providerId: "local", model: "replacement-model" },
  ])(
    "does not carry options into a different $providerId/$model target",
    ({ providerId, model }) => {
      const configured: RuntimeConfigFile = {
        ...BASE_CONFIG,
        models: {
          ...BASE_MODELS,
          embeddingProfiles: {
            "memory-embedding": {
              provider: "local",
              model: "embedding-model",
              options: { dimensions: 512 },
            },
          },
        },
      };

      const candidate = buildEnabledMemoryConfig({
        config: configured,
        providerId,
        model,
        profileId: "memory-embedding",
        emitClientEvents: false,
      });

      expect(candidate.models).toMatchObject({
        embeddingProfiles: {
          "memory-embedding": { provider: providerId, model },
        },
      });
      expect(
        (
          candidate.models as {
            embeddingProfiles: Record<string, Record<string, unknown>>;
          }
        ).embeddingProfiles["memory-embedding"],
      ).not.toHaveProperty("options");
    },
  );

  test("does not persist enablement after the client aborts", async () => {
    const harness = createRepositoryHarness(BASE_CONFIG);
    const controller = new AbortController();
    const service = createLongTermMemoryOnboardingService({
      repository: harness.repository,
      probe: vi.fn(async () => {
        controller.abort(new Error("client_disconnected"));
        return { modelFingerprint: "sha256:embedding", dimensions: 768 };
      }),
      discover: vi.fn(),
    });

    await expect(
      service.enable({
        providerId: "local",
        model: "embedding-model",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("client_disconnected");
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.current()).toEqual(BASE_CONFIG);
  });

  test("uses the same service contract for discovery, status, and disable", async () => {
    const enabledConfig: RuntimeConfigFile = {
      ...BASE_CONFIG,
      models: {
        ...BASE_MODELS,
        embeddingProfiles: {
          memory: { provider: "local", model: "embedding-model" },
        },
      },
      longTermMemory: {
        enabled: true,
        emitClientEvents: false,
        embeddingProfileId: "memory",
        maxRecallCallsPerRequest: 7,
      },
    };
    const harness = createRepositoryHarness(enabledConfig);
    const discover = vi.fn(async () => ({
      supported: true,
      models: ["embedding-a", "embedding-b"],
    }));
    const service = createLongTermMemoryOnboardingService({
      repository: harness.repository,
      probe: vi.fn(),
      discover,
    });

    await expect(service.status()).resolves.toMatchObject({
      enabled: true,
      profileId: "memory",
      providerId: "local",
      model: "embedding-model",
      providers: [{ id: "local", type: "ollama" }],
    });
    await expect(service.discover({ providerId: "local" })).resolves.toEqual({
      supported: true,
      models: ["embedding-a", "embedding-b"],
    });
    await expect(service.disable()).resolves.toMatchObject({
      restartRequired: true,
      status: { enabled: false, profileId: "memory" },
    });
    expect(harness.current().longTermMemory).toMatchObject({
      enabled: false,
      maxRecallCallsPerRequest: 7,
    });
  });

  test("rejects an unconfigured provider before probing", async () => {
    const harness = createRepositoryHarness(BASE_CONFIG);
    const probe = vi.fn();
    const service = createLongTermMemoryOnboardingService({
      repository: harness.repository,
      probe,
      discover: vi.fn(),
    });

    await expect(
      service.enable({ providerId: "missing", model: "embedding-model" }),
    ).rejects.toThrow("long_term_memory_provider_not_configured:missing");
    expect(probe).not.toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
  });

  test("does not overwrite configuration changed during the embedding probe", async () => {
    const harness = createRepositoryHarness(BASE_CONFIG);
    const concurrentConfig: RuntimeConfigFile = {
      ...BASE_CONFIG,
      requestRunner: { configRef: "./concurrent-request-runner.config.json" },
    };
    const service = createLongTermMemoryOnboardingService({
      repository: harness.repository,
      probe: vi.fn(async () => {
        harness.replaceCurrent(concurrentConfig);
        return { modelFingerprint: "sha256:embedding", dimensions: 768 };
      }),
      discover: vi.fn(),
    });

    await expect(
      service.enable({ providerId: "local", model: "embedding-model" }),
    ).rejects.toThrow("long_term_memory_config_changed");
    expect(harness.current()).toEqual(concurrentConfig);
  });
});

function createRepositoryHarness(initial: RuntimeConfigFile): {
  repository: LongTermMemoryOnboardingConfigRepository;
  write: ReturnType<typeof vi.fn>;
  current(): RuntimeConfigFile;
  replaceCurrent(next: RuntimeConfigFile): void;
} {
  let config = structuredClone(initial);
  const write = vi.fn(
    async (next: RuntimeConfigFile, expected?: RuntimeConfigFile) => {
      if (expected !== undefined && !isDeepStrictEqual(config, expected)) {
        throw new Error("long_term_memory_config_changed");
      }
      config = structuredClone(next);
      return { configPath: CONFIG_PATH, backupPath: `${CONFIG_PATH}.bak` };
    },
  );
  return {
    write,
    current: () => config,
    replaceCurrent(next) {
      config = structuredClone(next);
    },
    repository: {
      read: async () => ({
        config: structuredClone(config),
        path: CONFIG_PATH,
      }),
      write,
    },
  };
}
