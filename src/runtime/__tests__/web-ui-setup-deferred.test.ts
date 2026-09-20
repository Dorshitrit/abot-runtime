import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import * as credentials from "../../web-ui/local-runtime/runtime-setup-credentials.js";

let rootDir = "";
let configPath: string | undefined;
let registry: RuntimeEnvironmentRegistry;
let service: RuntimeSetupService;
const activate = vi.fn(async () => ({ status: "ready" as const }));
const configure = vi.fn((path: string) => {
  configPath = path;
  registry.configure(path);
});

beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/onboarding-plugins-1.4-20260908/extended-onboarding",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "setup-deferred-"));
  configPath = undefined;
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  activate.mockClear();
  configure.mockClear();
  registry = new RuntimeEnvironmentRegistry({
    rootDir,
    defaultEnvironmentId: "prod",
  });
  service = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure,
    activate,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await registry.stop();
  await rm(rootDir, { recursive: true, force: true });
});

describe("deferred onboarding activation", () => {
  test("saves connection and configures the pending gate without activating", async () => {
    const result = await service.save({
      provider: "ollama",
      model: "fixture-chat",
      deferActivation: true,
    });
    expect(result).toMatchObject({
      setup: { status: "ready" },
      activation: { status: "restart_required" },
    });
    expect(configPath).toBe(join(rootDir, "local/runtime.config.json"));
    expect(configure).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(registry.modelCatalog("prod").availability.status).toBe(
      "setup_required",
    );
    expect(
      await new RuntimeSetupService({
        rootDir,
        getConfigPath: () => configPath,
        activate,
      }).status(),
    ).toMatchObject({
      existingModel: { provider: "ollama", model: "fixture-chat" },
    });
  });

  test("preserves the original immediate activation default", async () => {
    await service.save({ provider: "ollama", model: "fixture-chat" });
    expect(activate).toHaveBeenCalledOnce();
  });

  test("rejects a malformed deferred option before configuring or writing", async () => {
    await expect(
      service.save({
        provider: "ollama",
        model: "fixture-chat",
        deferActivation: "true",
      }),
    ).rejects.toMatchObject({ code: "invalid_setup_activation" });
    expect(configure).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  test("gates the selected config before credential persistence can make it runnable", async () => {
    await service.save({
      provider: "openai",
      model: "fixture-chat",
      apiKey: "fixture-initial",
    });
    process.env.OPENAI_API_KEY = "";
    await writeFile(join(rootDir, ".env"), "");
    registry = new RuntimeEnvironmentRegistry({
      rootDir,
      configPath,
      defaultEnvironmentId: "prod",
    });
    expect(registry.modelCatalog("prod").availability.status).toBe(
      "setup_required",
    );
    const original = credentials.persistRuntimeSetupCredentials;
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((done) => {
      reached = done;
    });
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    vi.spyOn(credentials, "persistRuntimeSetupCredentials").mockImplementation(
      async (params) => {
        await original(params);
        reached();
        await waiting;
      },
    );
    const save = service.save({
      provider: "openai",
      model: "fixture-chat",
      apiKey: "fixture-replacement",
      deferActivation: true,
    });
    await paused;
    try {
      expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
        "fixture-replacement",
      );
      expect(registry.modelCatalog("prod").availability.status).toBe(
        "setup_required",
      );
    } finally {
      release();
      await save;
    }
    expect(registry.modelCatalog("prod").availability.status).toBe(
      "setup_required",
    );
  });
});
