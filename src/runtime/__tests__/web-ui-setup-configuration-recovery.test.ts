import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { createRuntimeOnboardingController } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

const artifacts = resolve(
  ".codex/artifacts/pr71-apply-recovery-20260908/configuration-recovery",
);
let rootDir = "";
let configPath = "";
beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "case-"));
  configPath = join(rootDir, "runtime.config.json");
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

test.each([
  {},
  { ollama: { type: "ollama", baseUrl: "http://127.0.0.1:11434" } },
])(
  "nonempty unresolved profiles route to Configuration while retaining their source",
  async (providers) => {
    const config = {
      models: {
        providers,
        profiles: {
          unfinished: { provider: "missing-provider", model: "preserved-chat" },
        },
      },
    };
    const raw = JSON.stringify(config);
    await writeFile(configPath, raw);
    const registry = new RuntimeEnvironmentRegistry({
      rootDir,
      configPath,
      defaultEnvironmentId: "prod",
    });
    const availability = registry.modelCatalog("prod").availability;
    expect(availability).toMatchObject({
      status: "setup_required",
      recovery: "configuration",
    });
    const configure = vi.fn();
    const service = new RuntimeSetupService({
      rootDir,
      getConfigPath: () => configPath,
      configure,
      activate: async () => ({ status: "ready" }),
    });
    await expect(
      service.save({ provider: "ollama", model: "replacement-chat" }),
    ).rejects.toMatchObject({
      code: "setup_configuration_exists",
      statusCode: 409,
    });
    expect(configure).not.toHaveBeenCalled();
    expect(await readFile(configPath, "utf8")).toBe(raw);
  },
);

test("an empty profile map still offers ordinary initial setup", async () => {
  await writeFile(
    configPath,
    JSON.stringify({ models: { providers: {}, profiles: {} } }),
  );
  const registry = new RuntimeEnvironmentRegistry({
    rootDir,
    configPath,
    defaultEnvironmentId: "prod",
  });
  expect(registry.modelCatalog("prod").availability).toMatchObject({
    status: "setup_required",
  });
  expect(registry.modelCatalog("prod").availability).not.toHaveProperty(
    "recovery",
  );
});

test("Configuration recovery offers navigation and refresh without provider or save controls", async () => {
  const openConfiguration = vi.fn();
  const harness = createGuideHarness({ openConfiguration });
  const state = { runtimeAvailability: { status: "loading" } };
  const reloadModels = vi.fn(async () => {});
  const controller = createRuntimeOnboardingController({
    state,
    guide: harness.guide,
    reloadModels,
    setMessageStatus: vi.fn(),
  });
  controller.bind();
  controller.applyCatalog({
    profiles: [],
    availability: {
      status: "setup_required",
      recovery: "configuration",
      message: "Repair the existing model profile in Configuration.",
    },
  });
  await harness.ready();
  expect(harness.container.innerHTML).toContain("Open Models");
  expect(harness.container.innerHTML).not.toContain(
    'data-runtime-setup-field="provider"',
  );
  expect(harness.loadSetup).not.toHaveBeenCalled();
  harness.click("configuration");
  expect(openConfiguration).toHaveBeenCalledOnce();
  harness.submit();
  expect(harness.saveSetup).not.toHaveBeenCalled();
  harness.click("check");
  await harness.ready();
  expect(reloadModels).toHaveBeenCalledOnce();
  controller.beginCatalogLoad();
  expect(harness.container.innerHTML).not.toContain(
    'data-runtime-setup-field="provider"',
  );
  controller.catalogUnavailable(new Error("fixture-refresh-failed"));
  expect(harness.container.innerHTML).toContain("Open Models");
  expect(harness.container.innerHTML).not.toContain(
    'data-runtime-setup-field="provider"',
  );
  controller.applyCatalog({
    profiles: [],
    availability: { status: "setup_required" },
  });
  await harness.ready();
  expect(harness.loadSetup).toHaveBeenCalledOnce();
  expect(harness.container.innerHTML).toContain(
    'data-runtime-setup-field="provider"',
  );
});

test("missing linked profiles offer Configuration repair without overwriting their references", async () => {
  const raw = JSON.stringify({
    models: {
      providers: {
        ollama: { type: "ollama", baseUrl: "http://127.0.0.1:11434" },
      },
      profiles: { preserved: { configRef: "./missing-model.json" } },
    },
  });
  await writeFile(configPath, raw);
  const registry = new RuntimeEnvironmentRegistry({
    rootDir,
    configPath,
    defaultEnvironmentId: "prod",
  });
  expect(registry.modelCatalog("prod").availability).toMatchObject({
    status: "setup_required",
    recovery: "configuration",
  });
  const service = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: vi.fn(),
    activate: async () => ({ status: "ready" }),
  });
  expect((await service.status()).recovery).toBe("configuration");
  await expect(
    service.save({ provider: "ollama", model: "replacement" }),
  ).rejects.toMatchObject({
    code: "setup_configuration_exists",
    statusCode: 409,
  });
  expect(await readFile(configPath, "utf8")).toBe(raw);
});

test("setup metadata recovery survives transient catalog refresh failures", async () => {
  const harness = createGuideHarness();
  harness.loadSetup.mockResolvedValue({
    setup: {
      ...setupSnapshot,
      recovery: "configuration",
      message: "Repair existing settings.",
    },
  });
  const controller = createRuntimeOnboardingController({
    state: { runtimeAvailability: { status: "loading" } },
    guide: harness.guide,
    reloadModels: vi.fn(async () => {}),
    setMessageStatus: vi.fn(),
  });
  controller.bind();
  controller.applyCatalog({
    profiles: [],
    availability: { status: "setup_required" },
  });
  await harness.ready();
  expect(harness.container.innerHTML).toContain("Open Models");
  controller.beginCatalogLoad();
  expect(harness.container.innerHTML).toContain("Open Models");
  controller.catalogUnavailable(new Error("temporary-catalog-failure"));
  expect(harness.container.innerHTML).toContain("Open Models");
  expect(harness.container.innerHTML).not.toContain(
    'data-runtime-setup-field="provider"',
  );
  harness.loadSetup.mockResolvedValue({ setup: setupSnapshot });
  controller.applyCatalog({
    profiles: [],
    availability: { status: "setup_required" },
  });
  await harness.ready();
  expect(harness.container.innerHTML).toContain(
    'data-runtime-setup-field="provider"',
  );
});

test.each(["missing", "malformed", "unknown-default"])(
  "an unusable request runner (%s) offers Configuration recovery",
  async (runnerCase) => {
    const runnerPath = join(rootDir, "runner.json");
    if (runnerCase === "malformed") await writeFile(runnerPath, "{");
    if (runnerCase === "unknown-default") {
      const runner = JSON.parse(
        await readFile(
          resolve("examples/request-runner.config.example.json"),
          "utf8",
        ),
      );
      runner.models.defaults.profileId = "unknown-profile";
      await writeFile(runnerPath, JSON.stringify(runner));
    }
    const raw = JSON.stringify({
      models: {
        providers: {
          ollama: { type: "ollama", baseUrl: "http://127.0.0.1:11434" },
        },
        profiles: {
          preserved: { provider: "ollama", model: "preserved-model" },
        },
      },
      requestRunner: { configRef: "./runner.json" },
    });
    await writeFile(configPath, raw);
    const registry = new RuntimeEnvironmentRegistry({
      rootDir,
      configPath,
      defaultEnvironmentId: "prod",
    });
    expect(registry.modelCatalog("prod").availability).toMatchObject({
      status: "setup_required",
      recovery: "configuration",
    });
    const service = new RuntimeSetupService({
      rootDir,
      getConfigPath: () => configPath,
      configure: vi.fn(),
      activate: async () => ({ status: "ready" }),
    });
    expect((await service.status()).recovery).toBe("configuration");
    await expect(
      service.save({ provider: "ollama", model: "replacement" }),
    ).rejects.toMatchObject({
      code: "setup_configuration_exists",
      statusCode: 409,
    });
    expect(await readFile(configPath, "utf8")).toBe(raw);
  },
);
