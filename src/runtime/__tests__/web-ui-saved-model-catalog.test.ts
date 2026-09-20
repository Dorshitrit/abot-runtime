import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplication,
} from "../local-application.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));

let fixture: ModelSetupFixture;
let registry: RuntimeEnvironmentRegistry;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-save-repair-20260908/saved-model-catalog",
  );
  registry = new RuntimeEnvironmentRegistry({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
  });
});
afterEach(async () => {
  await registry.stop();
  await fixture.cleanup();
});

async function savedRunner() {
  const config = await fixture.readConfig();
  const configPath = resolve(
    dirname(fixture.configPath),
    config.requestRunner.configRef,
  );
  return {
    configPath,
    value: JSON.parse(await readFile(configPath, "utf8")),
  };
}

async function renameSavedProfile(
  runner: Awaited<ReturnType<typeof savedRunner>>,
) {
  const config = await fixture.readConfig();
  config.models.profiles.repaired = config.models.profiles.default;
  delete config.models.profiles.default;
  if (config.models.defaults?.profileId === "default")
    config.models.defaults.profileId = "repaired";
  await fixture.writeConfig(config);
  runner.value.models.defaults.profileId = "repaired";
  for (const [step, target] of Object.entries(
    runner.value.models.defaults.steps,
  )) {
    if (target === "default")
      runner.value.models.defaults.steps[step] = "repaired";
  }
  await writeFile(runner.configPath, JSON.stringify(runner.value));
}

test.each(["default", "step-specific"])(
  "no-owner catalog reflects repaired %s runner targets without evicting another owner's cache",
  async (kind) => {
    expect(registry.modelCatalog("prod").defaultProfileId).toBe("default");
    const runner = await savedRunner();
    const cached = loadRequestRunnerConfig({ configPath: runner.configPath });
    await renameSavedProfile(runner);
    if (kind === "step-specific") {
      runner.value.models.defaults.steps["supervisor.response"] = "broken-step";
      await writeFile(runner.configPath, JSON.stringify(runner.value));
      expect(registry.modelCatalog("prod").availability).toMatchObject({
        status: "setup_required",
        recovery: "configuration",
      });
      runner.value.models.defaults.steps["supervisor.response"] = "repaired";
      await writeFile(runner.configPath, JSON.stringify(runner.value));
    }

    const catalog = registry.modelCatalog("prod");

    expect(catalog.availability.status).toBe("ready");
    expect(catalog.defaultProfileId).toBe("repaired");
    expect(catalog.profiles.map((profile) => profile.id)).toEqual(["repaired"]);
    expect(loadRequestRunnerConfig({ configPath: runner.configPath })).toBe(
      cached,
    );
    expect(cached.models.defaults.profileId).toBe("default");
    expect(cached.models.defaults.steps["supervisor.response"]).toBe("default");
    expect(createLocalRuntimeApplication).not.toHaveBeenCalled();
  },
);

test("active-owner catalog keeps its applied model configuration after saved files change", async () => {
  vi.mocked(createLocalRuntimeApplication).mockImplementation(
    (config) =>
      ({
        services: { config },
        getOwnership: () => "owner",
        stop: vi.fn(async () => {}),
      }) as unknown as LocalRuntimeApplication,
  );
  const active = registry.get("prod");
  const before = registry.modelCatalog("prod");
  const runner = await savedRunner();
  const cached = loadRequestRunnerConfig({ configPath: runner.configPath });
  await renameSavedProfile(runner);

  expect(registry.modelCatalog("prod")).toEqual(before);
  expect(registry.modelCatalog("prod").defaultProfileId).toBe("default");
  expect(registry.get("prod")).toBe(active);
  expect(loadRequestRunnerConfig({ configPath: runner.configPath })).toBe(
    cached,
  );
});

test("a saved catalog retains the existing unknown environment rejection", () => {
  expect(() => registry.modelCatalog("unknown-environment")).toThrow(
    "Unknown runtime environment profile: unknown-environment",
  );
});
