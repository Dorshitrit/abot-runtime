import * as setupDraft from "../../web-ui/local-runtime/runtime-setup-draft.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import type {
  RuntimeSetupInput,
  RuntimeSetupSnapshot,
} from "../../web-ui/app/components/runtime-setup-guide.js";
import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";
import { loadRuntimeConfig } from "../config.js";

const artifacts = resolve(
  ".codex/artifacts/onboarding-provider-retention-20260908",
);
const ollama = {
  provider: "ollama" as const,
  model: "local-chat",
  baseUrl: "http://127.0.0.1:11434",
  contextWindowTokens: 32768,
  deferActivation: true,
};
const openai = {
  provider: "openai" as const,
  model: "cloud-chat",
  apiKey: "fixture-retained-key",
  contextWindowTokens: 128000,
  deferActivation: true,
};
let rootDir = "";
let configPath: string | undefined;
let service: RuntimeSetupService;
const activate = vi.fn(async () => ({ status: "ready" as const }));
async function source() {
  return JSON.parse(await readFile(configPath!, "utf8"));
}
beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "provider-retention-"));
  configPath = undefined;
  activate.mockClear();
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  service = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: (path) => {
      configPath = path;
    },
    activate,
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

describe("unfinished setup provider ownership", () => {
  test("initial OpenAI setup creates only the selected provider", async () => {
    await service.save(openai);
    expect(Object.keys((await source()).models.providers)).toEqual(["openai"]);
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .provider,
    ).toBe("openai");
    expect(activate).not.toHaveBeenCalled();
  });

  test("switching removes an unused wizard-owned provider in both directions and retains its saved key", async () => {
    const initial = await service.save(ollama);
    const switched = await service.save({
      ...openai,
      connectionRevision: initial.setup.editableConnection!.revision,
    });
    expect(Object.keys((await source()).models.providers)).toEqual(["openai"]);
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .provider,
    ).toBe("openai");
    await service.save({
      ...ollama,
      connectionRevision: switched.setup.editableConnection!.revision,
    });
    expect(Object.keys((await source()).models.providers)).toEqual(["ollama"]);
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .provider,
    ).toBe("ollama");
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
      "fixture-retained-key",
    );
    expect(process.env.OPENAI_API_KEY).toBe("fixture-retained-key");
  });

  test("keeps a pre-existing provider that had no model profiles before the wizard", async () => {
    configPath = join(rootDir, "runtime.config.json");
    const existingProvider = { type: "ollama", baseUrl: ollama.baseUrl };
    await writeFile(
      configPath,
      JSON.stringify({ models: { providers: { ollama: existingProvider } } }),
    );
    const initial = await service.save(ollama);
    await service.save({
      ...openai,
      connectionRevision: initial.setup.editableConnection!.revision,
    });
    expect((await source()).models.providers).toEqual({
      ollama: existingProvider,
      openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" },
    });
  });

  test.each([
    [false, "ollama"],
    [true, "ollama"],
    [false, " ollama "],
  ] as const)(
    "retains the former provider with memory enabled %s and embedding provider reference %s",
    async (enabled, provider) => {
      const initial = await service.save(ollama);
      const config = await source();
      const embedding = { provider, model: "local-embedding" };
      config.models.embeddingProfiles = { "memory-embedding": embedding };
      config.longTermMemory = {
        enabled,
        embeddingProfileId: "memory-embedding",
      };
      await writeFile(configPath!, JSON.stringify(config));
      await service.save({
        ...openai,
        connectionRevision: initial.setup.editableConnection!.revision,
      });
      const updated = await source();
      expect(updated.models.providers.ollama).toEqual({
        type: "ollama",
        baseUrl: ollama.baseUrl,
      });
      expect(updated.models.providers.openai.type).toBe("openai");
      expect(updated.models.embeddingProfiles["memory-embedding"]).toEqual(
        embedding,
      );
      expect(updated.longTermMemory).toEqual({
        enabled,
        embeddingProfileId: "memory-embedding",
      });
    },
  );

  test.each([
    [true, "memory-embedding", " ollama "],
    [true, " memory-embedding ", "ollama"],
    [true, " memory-embedding ", " ollama "],
    [false, " memory-embedding ", " ollama "],
  ] as const)(
    "normalizes embedding references on address correction with enabled %s, profile %s, provider %s",
    async (enabled, embeddingProfileId, provider) => {
      const initial = await service.save(ollama);
      const config = await source();
      const embedding = { provider, model: "local-embedding" };
      config.models.embeddingProfiles = { "memory-embedding": embedding };
      config.longTermMemory = {
        enabled,
        embeddingProfileId,
        emitClientEvents: true,
      };
      await writeFile(configPath!, JSON.stringify(config));
      const result = await service.save({
        ...ollama,
        baseUrl: "http://corrected-host:11434",
        connectionRevision: initial.setup.editableConnection!.revision,
      });
      expect(result.embeddingInvalidated).toBe(enabled);
      const updated = await source();
      expect(updated.longTermMemory).toEqual({
        enabled: false,
        embeddingProfileId,
        emitClientEvents: true,
      });
      expect(updated.models.embeddingProfiles["memory-embedding"]).toEqual(
        embedding,
      );
      expect(updated.models.providers.ollama.baseUrl).toBe(
        "http://corrected-host:11434",
      );
    },
  );

  test("invalidates enabled embeddings with normalized references when the saved API key changes", async () => {
    const initial = await service.save(openai);
    const config = await source();
    const embedding = { provider: " openai ", model: "cloud-embedding" };
    config.models.embeddingProfiles = { "memory-embedding": embedding };
    config.longTermMemory = {
      enabled: true,
      embeddingProfileId: " memory-embedding ",
    };
    await writeFile(configPath!, JSON.stringify(config));
    const result = await service.save({
      ...openai,
      apiKey: "fixture-updated-key",
      connectionRevision: initial.setup.editableConnection!.revision,
    });
    expect(result.embeddingInvalidated).toBe(true);
    const updated = await source();
    expect(updated.longTermMemory).toEqual({
      enabled: false,
      embeddingProfileId: " memory-embedding ",
    });
    expect(updated.models.embeddingProfiles["memory-embedding"]).toEqual(
      embedding,
    );
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
      "fixture-updated-key",
    );
  });

  test("a receipt commit failure restores the old provider and draft, then permits the same switch to retry", async () => {
    const initial = await service.save(ollama);
    const original = await source();
    const connectionRevision = initial.setup.editableConnection!.revision;
    vi.spyOn(setupDraft, "writeRuntimeSetupDraft").mockRejectedValueOnce(
      new Error("fixture-receipt-failed"),
    );
    await expect(
      service.save({ ...openai, connectionRevision }),
    ).rejects.toThrow("fixture-receipt-failed");
    expect(await source()).toEqual(original);
    expect(Object.keys((await source()).models.providers)).toEqual(["ollama"]);
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .provider,
    ).toBe("ollama");
    expect((await service.status()).editableConnection?.revision).toBe(
      connectionRevision,
    );
    const retried = await service.save({ ...openai, connectionRevision });
    expect(Object.keys((await source()).models.providers)).toEqual(["openai"]);
    expect(retried.setup.editableConnection?.revision).not.toBe(
      connectionRevision,
    );
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .provider,
    ).toBe("openai");
  });

  test("editing the same provider keeps that connection while updating its address and model", async () => {
    const initial = await service.save(ollama);
    await service.save({
      ...ollama,
      model: "corrected-local-model",
      baseUrl: "http://corrected-host:11434",
      connectionRevision: initial.setup.editableConnection!.revision,
    });
    expect((await source()).models.providers).toEqual({
      ollama: { type: "ollama", baseUrl: "http://corrected-host:11434" },
    });
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .model,
    ).toBe("corrected-local-model");
  });

  test("entering Ollama details then choosing OpenAI before Save writes only OpenAI through the guide", async () => {
    const saveSetup = vi.fn(async (input: RuntimeSetupInput) => {
      const result = await service.save(input);
      return { ...result, setup: result.setup as RuntimeSetupSnapshot };
    });
    const harness = createGuideHarness({
      loadSetup: async () => ({
        setup: (await service.status()) as RuntimeSetupSnapshot,
      }),
      saveSetup,
      loadEmbeddingStatus: async () => ({
        status: {
          enabled: false,
          providers: Object.entries(
            loadRuntimeConfig({ rootDir, configPath }).models?.providers ?? {},
          ).map(([id, provider]) => ({ id, type: provider.type })),
        },
      }),
    });
    await harness.open();
    harness.changeProvider("ollama");
    harness.submit();
    harness.inputModel("abandoned-local-model");
    harness.click("back");
    harness.changeProvider("openai");
    harness.submit();
    harness.inputModel("selected-cloud-model");
    harness.inputKey("fixture-guide-key");
    harness.submit();
    await harness.ready();
    expect(saveSetup).toHaveBeenCalledOnce();
    expect(saveSetup.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "selected-cloud-model",
    });
    expect(Object.keys((await source()).models.providers)).toEqual(["openai"]);
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .model,
    ).toBe("selected-cloud-model");
    expect(activate).not.toHaveBeenCalled();
  });
});
