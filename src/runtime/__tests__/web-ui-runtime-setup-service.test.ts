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
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { loadRuntimeConfig } from "../config.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";

const artifactRoot = resolve(
  ".codex/artifacts/onboarding-plugins-1.4-20260908",
);
let rootDir = "";
let configPath: string | undefined;
let service: RuntimeSetupService;
const activate = vi.fn(async (path: string) => {
  configPath = path;
  return { status: "ready" as const };
});

beforeEach(async () => {
  await mkdir(artifactRoot, { recursive: true });
  rootDir = await mkdtemp(join(artifactRoot, "setup-service-"));
  configPath = undefined;
  activate.mockClear();
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("SETUP_TEST_API_KEY", "");
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  service = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    activate,
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

describe("Web runtime setup persistence", () => {
  test("creates the canonical runnable model and private credential file without disclosing a key", async () => {
    const initial = await service.status();
    expect(initial).toMatchObject({ status: "required", configExists: false });
    const result = await service.save({
      provider: "openai",
      model: "setup-test-model",
      apiKey: "fixture-test-not-a-real-secret",
    });
    expect(result).toMatchObject({
      setup: { status: "ready", configExists: true },
      activation: { status: "ready" },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-test-not-a-real-secret");
    const config = loadRuntimeConfig({ rootDir, configPath });
    expect(config.models?.profiles?.default).toMatchObject({
      provider: "openai",
      model: "setup-test-model",
    });
    const source = await readFile(configPath!, "utf8");
    expect(source).not.toContain("fixture-test-not-a-real-secret");
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
      'OPENAI_API_KEY="fixture-test-not-a-real-secret"',
    );
    expect((await stat(join(rootDir, ".env"))).mode & 0o777).toBe(0o600);
    expect(activate).toHaveBeenCalledOnce();
  });

  test("extends an empty configuration while preserving unrelated settings and existing credentials", async () => {
    configPath = join(rootDir, "runtime.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        logging: { enabled: false },
        plugins: { enabled: false },
      }),
    );
    const existing =
      'BRAVE_SEARCH_API_KEY="keep-existing"\nOPENAI_API_KEY="keep-openai"\n';
    await writeFile(join(rootDir, ".env"), existing);
    await service.save({
      provider: "ollama",
      model: "no-model-call",
      baseUrl: "http://127.0.0.1:12345",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      logging: { enabled: false },
      plugins: { enabled: false },
    });
    const credentials = await readFile(join(rootDir, ".env"), "utf8");
    expect(credentials).toContain(existing);
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default
        .model,
    ).toBe("no-model-call");
  });

  test("rejects invalid input and a missing key before any setup files are written", async () => {
    await expect(
      service.save({ provider: "openai", model: "test" }),
    ).rejects.toMatchObject({ code: "setup_credential_required" });
    await expect(
      service.save({
        provider: "openai",
        model: "test",
        apiKey: "key\nINJECT=value",
      }),
    ).rejects.toMatchObject({ code: "invalid_setup_credential" });
    await expect(
      service.save({
        provider: "ollama",
        model: "test",
        baseUrl: "http://localhost/path",
      }),
    ).rejects.toMatchObject({ code: "invalid_setup_base_url" });
    await expect(
      stat(join(rootDir, "local/runtime.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(activate).not.toHaveBeenCalled();
  });

  test("completes the configured OpenAI credential using custom apiKeyEnv without replacing model files", async () => {
    await service.save({
      provider: "openai",
      model: "configured-model",
      apiKey: "fixture-initial-placeholder",
    });
    process.env.OPENAI_API_KEY = "";
    const raw = JSON.parse(await readFile(configPath!, "utf8"));
    raw.models.providers.openai.apiKeyEnv = "SETUP_TEST_API_KEY";
    await writeFile(configPath!, JSON.stringify(raw));
    const originalConfig = await readFile(configPath!, "utf8");
    const modelPath = join(rootDir, "local/models/default.config.json");
    const originalModel = await readFile(modelPath, "utf8");
    expect(await service.status()).toMatchObject({
      status: "required",
      existingModel: { provider: "openai", model: "configured-model" },
    });
    const registry = new RuntimeEnvironmentRegistry({
      rootDir,
      configPath,
      defaultEnvironmentId: "prod",
    });
    expect(registry.modelCatalog("prod").availability.status).toBe(
      "setup_required",
    );
    const result = await service.save({
      provider: "openai",
      model: "configured-model",
      apiKey: "fixture-replacement-test",
    });
    expect(result.setup.status).toBe("ready");
    expect(await readFile(configPath!, "utf8")).toBe(originalConfig);
    expect(await readFile(modelPath, "utf8")).toBe(originalModel);
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
      'SETUP_TEST_API_KEY="fixture-replacement-test"',
    );
    expect(process.env.SETUP_TEST_API_KEY).toBe("fixture-replacement-test");
    expect(registry.modelCatalog("prod").availability.status).toBe("ready");
  });

  test("validates preserved invalid configuration before creating model files", async () => {
    configPath = join(rootDir, "runtime.config.json");
    const invalid = JSON.stringify({
      environment: { default: "prod", profiles: [] },
    });
    await writeFile(configPath, invalid);
    await expect(
      service.save({ provider: "ollama", model: "test" }),
    ).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(invalid);
    await expect(
      stat(join(rootDir, "models/default.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reads dotenv comments and export assignments while updating the durable config pointer", async () => {
    await writeFile(
      join(rootDir, ".env"),
      'export OPENAI_API_KEY="fixture-saved-test" # prior key\nOTHER=value\nLLM_RUNTIME_CONFIG_FILE=obsolete.json\n',
    );
    expect(
      (await service.status()).providers.find(
        (provider) => provider.id === "openai",
      )?.credentialConfigured,
    ).toBe(true);
    await service.save({
      provider: "openai",
      model: "existing-key",
      apiKey: "fixture-new-test",
    });
    const raw = await readFile(join(rootDir, ".env"), "utf8");
    expect(raw).not.toContain("fixture-saved-test");
    expect(raw).not.toContain("obsolete.json");
    expect(raw).toContain("OTHER=value");
    expect(raw.match(/OPENAI_API_KEY=/gu)).toHaveLength(1);
    const config = loadRuntimeConfig({ rootDir, configPath });
    for (const path of [
      config.paths.agentWorkDir,
      config.paths.attachmentsDir,
      config.paths.sessionsDir,
      config.paths.runtimeDir,
    ]) {
      expect((await stat(path)).isDirectory()).toBe(true);
    }
  });

  test("serializes duplicate setup saves and preserves the winning configuration", async () => {
    const results = await Promise.allSettled([
      service.save({ provider: "ollama", model: "first-model" }),
      service.save({ provider: "ollama", model: "second-model" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const config = loadRuntimeConfig({ rootDir, configPath });
    expect(["first-model", "second-model"]).toContain(
      config.models?.profiles?.default.model,
    );
    expect(activate).toHaveBeenCalledOnce();
  });
});
