import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import type { RuntimeConfig } from "../ports.js";
import * as lockInstallation from "../adapters/long-term-memory/file-lock/install.js";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import {
  applyBarrier,
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

function observeNextRootLockAttempt() {
  const outcome = applyBarrier<"acquired" | "contended">();
  const install = lockInstallation.installLockDirectory;
  vi.spyOn(lockInstallation, "installLockDirectory").mockImplementation(
    async (path, token) => {
      try {
        await install(path, token);
        if (path === fixture.configPath + ".config.lock")
          outcome.release("acquired");
      } catch (error) {
        if (path === fixture.configPath + ".config.lock")
          outcome.release("contended");
        throw error;
      }
    },
  );
  return outcome.waiting;
}

async function saveConcurrentConfiguration(
  kind: "model" | "plugin" | "runner",
) {
  const alias = join(dirname(fixture.configPath), "runtime-alias.config.json");
  await symlink(fixture.configPath, alias);
  const options = { rootDir: fixture.rootDir, configPath: alias };
  if (kind === "model")
    return new ModelSetupService({
      rootDir: fixture.rootDir,
      getConfigPath: () => alias,
    }).add({ profileId: "later", providerId: "ollama", model: "later-model" });
  if (kind === "plugin") {
    return setRuntimePluginEnabled(options, {
      pluginId: "filesystem",
      enabled: false,
    });
  }
  const snapshot = await getConfigDashboardSnapshot(options);
  const runner = snapshot.files.requestRunner!;
  return saveConfigDashboardFile({
    ...options,
    kind: "requestRunner",
    config: {
      ...runner.config,
      stepDefaults: { timeoutMs: 12345 },
    },
    expectedRevision: runner.revision,
  });
}

test.each(["model", "plugin", "runner"] as const)(
  "Apply holds one canonical source while a concurrent %s save waits through gateway activation",
  async (kind) => {
    const entered = applyBarrier();
    const resume = applyBarrier();
    let gatewayConfig: RuntimeConfig | undefined;
    fixture.owners[0]!.stopIfIdle.mockImplementationOnce(async () => {
      entered.release();
      await resume.waiting;
      return true;
    });
    fixture.activate.mockImplementation(async (configPath) => {
      gatewayConfig = loadRuntimeConfig({
        rootDir: fixture.rootDir,
        configPath,
      });
      return { status: "ready" };
    });
    const applying = fixture.registry.applyConfiguration();
    await entered.waiting;
    const observed = observeNextRootLockAttempt();
    const saving = saveConcurrentConfiguration(kind);
    let outcome: string;
    try {
      outcome = await observed;
      if (outcome === "acquired") await saving;
    } finally {
      resume.release();
    }
    await expect(applying).resolves.toMatchObject({ status: "ready" });
    await saving;
    expect(outcome!).toBe("contended");
    const replacement = fixture.owners[1]!.services.config;
    expect(gatewayConfig!.models).toEqual(replacement.models);
    expect(gatewayConfig!.plugins).toEqual(replacement.plugins);
    if (kind === "model")
      expect(replacement.models?.profiles).not.toHaveProperty("later");
    if (kind === "plugin")
      expect(replacement.plugins?.deny ?? []).not.toContain("filesystem");
    if (kind === "runner")
      expect((await fixture.readRunner()).stepDefaults.timeoutMs).toBe(12345);
  },
);

test("Apply retains its root transaction until failed gateway activation restores prior environments", async () => {
  const restoring = applyBarrier();
  const resume = applyBarrier();
  const failure = new Error("gateway activation fixture failed");
  fixture.activate.mockRejectedValueOnce(failure);
  const previous = fixture.owners[0]!;
  const { createLocalRuntimeApplication } =
    await import("../local-application.js");
  const create = vi
    .mocked(createLocalRuntimeApplication)
    .getMockImplementation()!;
  vi.mocked(createLocalRuntimeApplication).mockImplementation(
    (config, options) => {
      const owner = create(config, options);
      if (config === previous.services.config) {
        vi.mocked(owner.start).mockImplementationOnce(async () => {
          restoring.release();
          await resume.waiting;
        });
      }
      return owner;
    },
  );
  const applying = fixture.registry
    .applyConfiguration()
    .catch((error: unknown) => error);
  await restoring.waiting;
  const observed = observeNextRootLockAttempt();
  const saving = saveConcurrentConfiguration("model");
  let outcome: string;
  try {
    outcome = await observed;
    if (outcome === "acquired") await saving;
  } finally {
    resume.release();
  }
  expect(await applying).toBe(failure);
  await saving;
  expect(outcome!).toBe("contended");
  expect(fixture.registry.get("prod").services.config).toBe(
    previous.services.config,
  );
});
