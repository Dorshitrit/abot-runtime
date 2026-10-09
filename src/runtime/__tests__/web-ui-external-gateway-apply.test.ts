import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplication,
} from "../local-application.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import type { RuntimeConfig } from "../ports.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { RuntimeSetupGateway } from "../../web-ui/runtime-setup-gateway.js";
import { removeRuntimePlugin } from "../../web-ui/plugin-removal-service.js";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import {
  installPluginPackage,
  inspectPluginPackage,
} from "../plugins/installation/service.js";
import {
  communityArchive,
  pluginSource,
  sourceFetcher,
} from "./support/plugin-installation-fixture.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));

function createOwner(config: RuntimeConfig, onStart?: () => Promise<void>) {
  let closed = false;
  return {
    services: { config },
    start: vi.fn(async () => {
      if (closed) throw new Error("local_runtime_stopped");
      await onStart?.();
    }),
    stop: vi.fn(async () => {
      closed = true;
    }),
    stopIfIdle: vi.fn(async () => {
      closed = true;
      return true;
    }),
    isOwnerIdle: () => !closed,
    getOwnership: () => (closed ? undefined : ("owner" as const)),
    subscribeScheduledEvents: vi.fn(),
  };
}

let fixture: ModelSetupFixture;
let gateway: RuntimeSetupGateway;
let registry: RuntimeEnvironmentRegistry;
let external: Server;
let gatewayUrl: string;
let runnerPath: string;
let nextOwnerStart: (() => Promise<void>) | undefined;
const owners: ReturnType<typeof createOwner>[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("LLM_RUNTIME_TRACE", "0");
  owners.splice(0);
  nextOwnerStart = undefined;
  external = createServer((_request, response) =>
    response.end("external-gateway"),
  );
  await new Promise<void>((done, reject) => {
    external.once("error", reject);
    external.listen(0, "127.0.0.1", () => {
      external.off("error", reject);
      done();
    });
  });
  gatewayUrl = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  vi.stubEnv("MODEL_GATEWAY_URL", gatewayUrl);
  fixture = await createModelSetupFixture(
    ".codex/artifacts/plugin-only-activation-20261007/external-gateway-apply",
  );
  await fixture.service.add({
    profileId: "alternate",
    providerId: "ollama",
    model: "alternate-model",
  });
  const config = await fixture.readConfig();
  runnerPath = resolve(
    dirname(fixture.configPath),
    config.requestRunner.configRef,
  );
  gateway = new RuntimeSetupGateway({ rootDir: fixture.rootDir });
  vi.mocked(createLocalRuntimeApplication).mockImplementation(
    (runtimeConfig) => {
      const owner = createOwner(runtimeConfig!, nextOwnerStart);
      nextOwnerStart = undefined;
      owners.push(owner);
      return owner as unknown as LocalRuntimeApplication;
    },
  );
  registry = new RuntimeEnvironmentRegistry({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
    captureRuntimeSetupConfiguration: (configPath) =>
      gateway.captureConfiguration(configPath),
    checkRuntimeSetupActivation: (configPath, appliedConfigurations) =>
      gateway.checkActivation(configPath, appliedConfigurations),
    onRuntimeSetup: (configPath, appliedConfigurations) =>
      gateway.activate(configPath, appliedConfigurations),
    createRuntimeSetupRestorePoint: () => gateway.createRestorePoint(),
  });
  await registry.start(["prod"]);
  expect(owners).toHaveLength(1);
});

afterEach(async () => {
  await registry?.stop();
  await gateway?.close();
  external?.closeAllConnections();
  if (external?.listening)
    await new Promise<void>((done) => external.close(() => done()));
  await fixture?.cleanup();
});

async function savePluginSelection(): Promise<void> {
  const config = await fixture.readConfig();
  config.plugins = {
    ...config.plugins,
    disabledPluginIds: ["fixture-publication"],
  };
  await fixture.writeConfig(config);
}

async function saveChangedModel(): Promise<void> {
  const profile = await fixture.readModelProfile("default");
  await fixture.writeModelProfile("default", {
    ...profile,
    model: "changed-model",
  });
}

async function saveChangedRunner(): Promise<void> {
  const runner = JSON.parse(await readFile(runnerPath, "utf8"));
  runner.models.defaults.profileId = "alternate";
  await writeFile(runnerPath, JSON.stringify(runner));
}

async function expectExternalGatewayAlive(): Promise<void> {
  const response = await fetch(gatewayUrl, {
    headers: { Connection: "close" },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("external-gateway");
  expect(external.listening).toBe(true);
}

test("plugin-only Apply refreshes runtime selection and preserves the external gateway", async () => {
  const previous = owners[0]!;
  expect(
    previous.services.config.plugins?.disabledPluginIds ?? [],
  ).not.toContain("fixture-publication");
  await savePluginSelection();

  await expect(registry.applyConfiguration()).resolves.toEqual({
    status: "ready",
  });

  const active = registry.get("prod");
  expect(active).not.toBe(previous);
  expect(active.services.config.plugins?.disabledPluginIds).toEqual([
    "fixture-publication",
  ]);
  expect(previous.stopIfIdle).toHaveBeenCalledOnce();
  expect(active.start).toHaveBeenCalledOnce();
  await expectExternalGatewayAlive();
  // An unchanged external listener never becomes owned by the Web gateway helper.
  await gateway.close();
  await expectExternalGatewayAlive();
});

test.each(["linked model", "linked runner"] as const)(
  "%s changes prevent plugin Apply before the running owner is stopped",
  async (change) => {
    const previous = owners[0]!;
    const previousRunner = loadRequestRunnerConfig({ configPath: runnerPath });
    await savePluginSelection();
    const saveChangedSource = {
      "linked model": saveChangedModel,
      "linked runner": saveChangedRunner,
    }[change];
    await saveChangedSource();

    await expect(registry.applyConfiguration()).resolves.toMatchObject({
      status: "restart_required",
    });

    expect(registry.get("prod")).toBe(previous);
    expect(previous.stopIfIdle).not.toHaveBeenCalled();
    expect(previous.stop).not.toHaveBeenCalled();
    expect(owners).toHaveLength(1);
    expect(loadRequestRunnerConfig({ configPath: runnerPath })).toBe(
      previousRunner,
    );
    await expectExternalGatewayAlive();
  },
);

test("failed replacement restores the prior baseline instead of adopting newly saved model configuration", async () => {
  const previous = owners[0]!;
  const failure = new Error("replacement_start_failed");
  await savePluginSelection();
  nextOwnerStart = async () => {
    // A file edit during failed startup must not become the restored owner's baseline.
    await saveChangedModel();
    throw failure;
  };

  await expect(registry.applyConfiguration()).rejects.toBe(failure);

  const restored = registry.get("prod");
  expect(restored).not.toBe(previous);
  expect(restored.services.config).toBe(previous.services.config);
  expect(
    restored.services.config.plugins?.disabledPluginIds ?? [],
  ).not.toContain("fixture-publication");
  expect(restored.start).toHaveBeenCalledOnce();
  expect(previous.stopIfIdle).toHaveBeenCalledOnce();
  expect(owners).toHaveLength(3);
  expect(owners[1]!.stop).toHaveBeenCalledOnce();
  await expectExternalGatewayAlive();

  await expect(registry.applyConfiguration()).resolves.toMatchObject({
    status: "restart_required",
  });
  expect(registry.get("prod")).toBe(restored);
  expect(restored.stopIfIdle).not.toHaveBeenCalled();
  expect(owners).toHaveLength(3);
  await expectExternalGatewayAlive();
});

test("installed plugin removal waits for disabled selection and applied runtime without taking over the external gateway", async () => {
  const pluginId = "community-example";
  const packagePath = join(fixture.rootDir, "plugins", pluginId);
  const download = sourceFetcher(await communityArchive());
  const reviewed = await inspectPluginPackage(
    fixture.rootDir,
    pluginSource,
    download,
  );
  await installPluginPackage({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    download,
    input: { source: reviewed.source, digest: reviewed.digest },
    saveSelection: (id, transaction) =>
      setRuntimePluginEnabled(
        fixture,
        { pluginId: id, enabled: true },
        transaction,
      ),
  });
  await expect(registry.applyConfiguration()).resolves.toEqual({
    status: "ready",
  });
  const previous = registry.get("prod");
  expect(() =>
    registry.requirePluginInactive(pluginId, ["community_ping"]),
  ).toThrow("still available");

  let releaseApply!: () => void;
  let reportApplied!: () => void;
  const applied = new Promise<void>((done) => {
    reportApplied = done;
  });
  const readyGate = new Promise<void>((done) => {
    releaseApply = done;
  });
  const requireInactive = vi.fn(
    (id: string, capabilities: readonly string[]) => {
      expect(existsSync(packagePath)).toBe(true);
      registry.requirePluginInactive(id, capabilities);
    },
  );
  const applyConfiguration = vi.fn(async (revision: string) => {
    expect(existsSync(packagePath)).toBe(true);
    expect((await fixture.readConfig()).plugins.disabledPluginIds).toContain(
      pluginId,
    );
    expect(
      previous.services.config.plugins?.disabledPluginIds ?? [],
    ).not.toContain(pluginId);
    const activation = await registry.applyConfiguration(revision);
    expect(activation.status).toBe("ready");
    reportApplied();
    await readyGate;
    return activation;
  });
  const removing = removeRuntimePlugin(
    {
      rootDir: fixture.rootDir,
      configPath: fixture.configPath,
      requireMutationIdle: () => registry.requirePluginMutationIdle(),
      applyConfiguration,
      requireInactive,
    },
    { pluginId },
  );
  try {
    await Promise.race([
      applied,
      removing.then(() => {
        throw new Error("plugin_removal_finished_before_ready_gate");
      }),
    ]);
    expect(existsSync(packagePath)).toBe(true);
    expect(requireInactive).not.toHaveBeenCalled();
  } finally {
    releaseApply();
  }
  const result = await removing;

  expect(result).toMatchObject({
    removed: true,
    activation: { status: "ready" },
  });
  expect(existsSync(packagePath)).toBe(false);
  expect(applyConfiguration).toHaveBeenCalledOnce();
  expect(requireInactive).toHaveBeenCalledWith(pluginId, ["community_ping"]);
  expect(previous.stopIfIdle).toHaveBeenCalledOnce();
  expect(
    registry.get("prod").services.config.plugins?.disabledPluginIds,
  ).toContain(pluginId);
  await expectExternalGatewayAlive();
  await gateway.close();
  await expectExternalGatewayAlive();
});
