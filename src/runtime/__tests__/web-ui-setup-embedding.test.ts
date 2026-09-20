import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
} from "../../model-gateway/index.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { SetupEmbeddingService } from "../../web-ui/local-runtime/setup-embedding-service.js";

let rootDir = "";
let configPath: string | undefined;
const embed = vi.fn<NonNullable<ModelProviderAdapter["embed"]>>();
let service: SetupEmbeddingService;
const signal = () => new AbortController().signal;
const readConfig = async () => JSON.parse(await readFile(configPath!, "utf8"));
const readCredentials = () => readFile(join(rootDir, ".env"), "utf8");

beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/onboarding-plugins-1.4-20260908/extended-onboarding",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "embedding-service-"));
  configPath = undefined;
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("EMBEDDING_FIXTURE_KEY", "");
  embed.mockReset();
  embed.mockImplementation(async ({ texts }) => ({
    kind: "embedded",
    modelFingerprint: "fixture:fingerprint",
    vectors: texts.map(() => [0.2, 0.8]),
  }));
  const providerAdapters = createModelProviderAdapterRegistry(
    ["openai", "ollama", "fixture-provider"].map((type) => ({
      type,
      supportsImageInput: false,
      embed,
      invoke: async () => ({ kind: "raw" as const, body: {} }),
    })),
  );
  const setup = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: (path) => {
      configPath = path;
    },
    activate: vi.fn(async () => ({ status: "ready" as const })),
  });
  await setup.save({
    provider: "ollama",
    model: "fixture-chat",
    baseUrl: "http://127.0.0.1:19999",
    deferActivation: true,
  });
  service = new SetupEmbeddingService({
    rootDir,
    getConfigPath: () => configPath,
    providerAdapters,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

describe("setup embedding connection and canonical memory save", () => {
  test("uses an existing provider and preserves chat profiles and unrelated settings", async () => {
    const before = await readConfig();
    const result = await service.enable(
      { providerId: "ollama", model: "fixture-embedding" },
      signal(),
    );
    expect(result).toMatchObject({
      restartRequired: true,
      status: {
        enabled: true,
        providerId: "ollama",
        model: "fixture-embedding",
      },
      probe: { dimensions: 2, modelFingerprint: "fixture:fingerprint" },
    });
    const after = await readConfig();
    expect(after.models.providers).toEqual(before.models.providers);
    expect(after.models.profiles).toEqual(before.models.profiles);
    expect(after.plugins).toEqual(before.plugins);
    expect(after.requestRunner).toEqual(before.requestRunner);
    expect(embed).toHaveBeenCalledOnce();
    expect(embed.mock.calls[0][0].texts).toEqual([
      "ABot long-term memory embedding capability probe.",
    ]);
  });

  test("adds a different OpenAI provider without changing the chat model or exposing its key", async () => {
    const before = await readConfig();
    const key = "fixture-embedding-not-a-real-key";
    const result = await service.enable(
      { provider: "openai", model: "fixture-embedding", apiKey: key },
      signal(),
    );
    expect(result.status).toMatchObject({
      enabled: true,
      providerId: "openai",
    });
    const after = await readConfig();
    expect(after.models.providers.ollama).toEqual(
      before.models.providers.ollama,
    );
    expect(after.models.providers.openai).toMatchObject({
      type: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(after.models.profiles).toEqual(before.models.profiles);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(after)).not.toContain(key);
    expect(await readCredentials()).toContain(key);
    expect((await stat(join(rootDir, ".env"))).mode & 0o777).toBe(0o600);
  });

  test("reuses an existing OpenAI connection and its custom saved credential", async () => {
    const config = await readConfig();
    const provider = {
      type: "openai",
      apiKeyEnv: "EMBEDDING_FIXTURE_KEY",
      baseUrl: "https://fixture.example/v1",
    };
    config.models.providers.embedding = provider;
    await writeFile(configPath!, JSON.stringify(config));
    await writeFile(
      join(rootDir, ".env"),
      'EMBEDDING_FIXTURE_KEY="fixture-custom-saved"\nOTHER="preserved"\n',
    );
    const result = await service.enable(
      { providerId: "embedding", model: "fixture-embedding" },
      signal(),
    );
    expect(result.status.providerId).toBe("embedding");
    expect((await readConfig()).models.providers.embedding).toEqual(provider);
    expect(process.env.EMBEDDING_FIXTURE_KEY).toBe("fixture-custom-saved");
    expect(await readCredentials()).toContain('OTHER="preserved"');
    expect(JSON.stringify(result)).not.toContain("fixture-custom-saved");
  });

  test("adds an Ollama connection after OpenAI chat setup without replacing the existing provider", async () => {
    const config = await readConfig();
    config.models.providers = {
      openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" },
    };
    config.models.profiles = {
      chat: {
        provider: "openai",
        model: "fixture-chat",
        contextWindowTokens: 32768,
      },
    };
    await writeFile(configPath!, JSON.stringify(config));
    await service.enable(
      {
        provider: "ollama",
        model: "fixture-local-embedding",
        baseUrl: "http://127.0.0.1:19998",
      },
      signal(),
    );
    const after = await readConfig();
    expect(after.models.providers).toMatchObject({
      openai: config.models.providers.openai,
      ollama: { type: "ollama", baseUrl: "http://127.0.0.1:19998" },
    });
    expect(after.models.profiles).toEqual(config.models.profiles);
  });

  test("keeps completed provider and key saves on failed probe, while memory stays unchanged and retry succeeds", async () => {
    const before = await readConfig();
    const key = "fixture-failed-probe-key";
    embed.mockRejectedValueOnce(new Error(`upstream echoed ${key}`));
    const result = await service
      .enable(
        { provider: "openai", model: "fixture-embedding", apiKey: key },
        signal(),
      )
      .catch((error: unknown) => error);
    expect(result).toMatchObject({
      code: "embedding_setup_failed",
      providerSaved: true,
    });
    expect(String(result)).not.toContain(key);
    const failed = await readConfig();
    expect(failed.longTermMemory).toEqual(before.longTermMemory);
    expect(failed.models.embeddingProfiles).toEqual(
      before.models.embeddingProfiles,
    );
    expect(failed.models.providers.openai).toMatchObject({ type: "openai" });
    expect(await readCredentials()).toContain(key);
    await expect(
      service.enable(
        { providerId: "openai", model: "fixture-embedding" },
        signal(),
      ),
    ).resolves.toMatchObject({ status: { enabled: true } });
  });

  test.each([
    { provider: "openai", providerId: "ollama", model: "fixture" },
    { provider: "unknown", model: "fixture" },
    { provider: "openai", model: "" },
    { provider: "openai", model: "fixture", apiKey: "bad\nkey" },
    {
      provider: "openai",
      model: "fixture",
      apiKey: "fixture-key",
      dimensions: 2,
    },
    { provider: "ollama", model: "fixture", baseUrl: "http://127.0.0.1/path" },
    { providerId: "ollama", model: "fixture", apiKey: "fixture-key" },
    { provider: "ollama", model: "fixture", baseUrl: "http://127.0.0.1:18888" },
    { provider: "openai", model: "fixture" },
  ])(
    "rejects malformed, conflicting, or incomplete connection before persistence: %j",
    async (input) => {
      const config = await readFile(configPath!, "utf8");
      const credentials = await readCredentials();
      await expect(service.enable(input, signal())).rejects.toThrow();
      expect(await readFile(configPath!, "utf8")).toBe(config);
      expect(await readCredentials()).toBe(credentials);
      expect(embed).not.toHaveBeenCalled();
    },
  );
});
