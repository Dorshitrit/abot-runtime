import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import { loadRuntimeModelCatalog } from "../model/model-catalog.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import {
  createApplyFixture,
  type ApplyFixture,
} from "./support/web-ui-apply-fixture.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));
let fixture: ApplyFixture;
beforeEach(async () => {
  fixture = await createApplyFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

async function saveRunner(profileId: string, timeoutMs = 12345) {
  const snapshot = await getConfigDashboardSnapshot(fixture);
  const current = snapshot.files.requestRunner!;
  const config = await fixture.readRunner();
  const previousDefault = config.models.defaults.profileId;
  config.models.defaults.profileId = profileId;
  for (const [step, target] of Object.entries(config.models.defaults.steps))
    if (target === previousDefault)
      config.models.defaults.steps[step] = profileId;
  config.stepDefaults.timeoutMs = timeoutMs;
  await saveConfigDashboardFile({
    ...fixture,
    kind: "requestRunner",
    config,
    expectedRevision: current.revision,
  });
}

test("Apply reloads saved runner defaults and timeouts without invalidating a different runner cache", async () => {
  await fixture.service.add({
    profileId: "later",
    providerId: "ollama",
    model: "later-model",
  });
  const unrelatedPath = join(
    dirname(fixture.runnerPath),
    "unrelated-runner.json",
  );
  await writeFile(unrelatedPath, await readFile(fixture.runnerPath, "utf8"));
  const unrelated = loadRequestRunnerConfig({ configPath: unrelatedPath });
  const previous = loadRequestRunnerConfig({ configPath: fixture.runnerPath });
  await saveRunner("later");
  fixture.activate.mockImplementation(async (configPath) => {
    loadRuntimeConfig({ rootDir: fixture.rootDir, configPath });
    return { status: "ready" };
  });
  await expect(fixture.registry.applyConfiguration()).resolves.toMatchObject({
    status: "ready",
  });
  expect(fixture.registry.modelCatalog("prod").defaultProfileId).toBe("later");
  const current = loadRequestRunnerConfig({ configPath: fixture.runnerPath });
  expect(current).not.toBe(previous);
  expect(current.steps["supervisor.decision"].timeoutMs).toBe(12345);
  expect(loadRequestRunnerConfig({ configPath: unrelatedPath })).toBe(
    unrelated,
  );
});

test("Apply validates newly saved model IDs against the newly saved runner references", async () => {
  const snapshot = await getConfigDashboardSnapshot(fixture);
  const model = snapshot.files.models.find(
    ({ id }) => id === "default",
  )!.config;
  const config = await fixture.readConfig();
  config.models.profiles = {
    replacement: { ...model, model: "replacement-model" },
  };
  await saveConfigDashboardFile({ ...fixture, kind: "runtime", config });
  await saveRunner("replacement");
  fixture.activate.mockImplementation(async (configPath) => {
    loadRuntimeConfig({ rootDir: fixture.rootDir, configPath });
    return { status: "ready" };
  });
  await expect(fixture.registry.applyConfiguration()).resolves.toMatchObject({
    status: "ready",
  });
  expect(fixture.registry.modelCatalog("prod").defaultProfileId).toBe(
    "replacement",
  );
  expect(fixture.owners[0]!.stopIfIdle).toHaveBeenCalledOnce();
});

test("Apply rejects invalid saved cross-references before stopping current owners", async () => {
  await saveRunner("unknown-profile");
  await expect(fixture.registry.applyConfiguration()).rejects.toThrow(
    "unknown model profile unknown-profile",
  );
  expect(fixture.owners[0]!.stopIfIdle).not.toHaveBeenCalled();
  expect(fixture.activate).not.toHaveBeenCalled();
  expect(fixture.registry.get("prod")).toBe(fixture.owners[0]);
  expect(fixture.registry.modelCatalog("prod").defaultProfileId).toBe(
    "default",
  );
});

test("a busy owner blocks Apply without refreshing its cached runner", async () => {
  const previous = loadRequestRunnerConfig({ configPath: fixture.runnerPath });
  vi.spyOn(fixture.owners[0]!, "isOwnerIdle").mockReturnValue(false);
  await saveRunner("unknown-profile");
  await expect(fixture.registry.applyConfiguration()).resolves.toMatchObject({
    status: "restart_required",
  });
  expect(loadRequestRunnerConfig({ configPath: fixture.runnerPath })).toBe(
    previous,
  );
  expect(fixture.owners[0]!.stopIfIdle).not.toHaveBeenCalled();
});

test.each(["throw", "pending"] as const)(
  "%s gateway activation restores the previous cached runner before old-owner startup",
  async (outcome) => {
    const previousConfig = fixture.owners[0]!.services.config;
    const previousRunner = loadRequestRunnerConfig({
      configPath: fixture.runnerPath,
    });
    await fixture.service.add({
      profileId: "later",
      providerId: "ollama",
      model: "later-model",
    });
    await saveRunner("later");
    const failure = new Error("gateway apply failed");
    fixture.activate.mockImplementation(async () => {
      if (outcome === "throw") throw failure;
      return {
        status: "restart_required",
        message: "Gateway is externally managed",
      };
    });
    const startedDefaults: string[] = [];
    const create = vi
      .mocked(createLocalRuntimeApplication)
      .getMockImplementation()!;
    vi.mocked(createLocalRuntimeApplication).mockImplementation(
      (config, options) => {
        const owner = create(config, options);
        if (config === previousConfig)
          vi.mocked(owner.start).mockImplementationOnce(async () => {
            startedDefaults.push(
              loadRuntimeModelCatalog(config!).defaultProfileId,
            );
          });
        return owner;
      },
    );
    const applying = fixture.registry.applyConfiguration();
    if (outcome === "throw") await expect(applying).rejects.toBe(failure);
    else
      await expect(applying).resolves.toMatchObject({
        status: "restart_required",
      });
    expect(startedDefaults).toEqual(["default"]);
    expect(loadRequestRunnerConfig({ configPath: fixture.runnerPath })).toBe(
      previousRunner,
    );
    expect(fixture.registry.modelCatalog("prod").defaultProfileId).toBe(
      "default",
    );
    expect((await fixture.readRunner()).models.defaults.profileId).toBe(
      "later",
    );
  },
);
