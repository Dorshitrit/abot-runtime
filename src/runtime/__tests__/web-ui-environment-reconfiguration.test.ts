import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplication,
} from "../local-application.js";
import type { RuntimeConfig } from "../ports.js";
import type { LocalRuntimeBackendOptions } from "../../web-ui/local-runtime/contracts.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { resolveWebUiEnvironmentConfig } from "../../web-ui/environment-config.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));

let rootDir = "";
let configPath = "";
let registry: RuntimeEnvironmentRegistry;
let options: LocalRuntimeBackendOptions;
const owners: ReturnType<typeof environment>[] = [];

function environment(config: RuntimeConfig) {
  return {
    services: { config },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getOwnership: vi.fn(() => "owner"),
    isOwnerIdle: vi.fn(() => true),
    stopIfIdle: vi.fn(async () => true),
    subscribeScheduledEvents: vi.fn(),
  };
}

async function setProfiles(ids: string[], defaultId = ids[0]!) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const template = Object.values(config.environment.profiles)[0];
  config.environment.default = defaultId;
  config.environment.profiles = Object.fromEntries(
    ids.map((id) => [id, template]),
  );
  await writeFile(configPath, JSON.stringify(config));
}

beforeEach(async () => {
  vi.clearAllMocks();
  owners.splice(0);
  const artifacts = resolve(".codex/artifacts/pr71-review-fixes-20260908");
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "environments-"));
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.mocked(createLocalRuntimeApplication).mockImplementation((config) => {
    const owner = environment(config!);
    owners.push(owner);
    return owner as unknown as LocalRuntimeApplication;
  });
  const setup = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => undefined,
    activate: async (path) => {
      configPath = path;
      return { status: "restart_required" };
    },
  });
  await setup.save({ provider: "ollama", model: "fixture-model" });
  await setProfiles(["prod", "dev"]);
  options = {
    rootDir,
    configPath,
    defaultEnvironmentId: "prod",
    resolveEnvironmentConfig: (path) =>
      resolveWebUiEnvironmentConfig({ rootDir, configPath: path }),
    onRuntimeSetup: async () => ({ status: "ready" }),
  };
  registry = new RuntimeEnvironmentRegistry(options);
});

afterEach(async () => {
  await registry?.stop();
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

test("removed environments retire without loading deleted profiles; new default and membership become visible", async () => {
  await registry.start(["prod", "dev"]);
  const previous = [...owners];
  await setProfiles(["prod", "qa"], "qa");
  expect(await registry.applyConfiguration()).toEqual({ status: "ready" });
  for (const owner of previous) expect(owner.stopIfIdle).toHaveBeenCalledOnce();
  expect(owners).toHaveLength(4);
  expect(owners[2]!.start).toHaveBeenCalledOnce();
  expect(owners[3]!.start).toHaveBeenCalledOnce();
  expect(registry.environmentConfig()).toMatchObject({
    defaultEnvironmentId: "qa",
    environments: [
      { id: "prod", isDefault: false },
      { id: "qa", isDefault: true },
    ],
  });
  expect(registry.profileEnv("").LLM_RUNTIME_PROFILE).toBe("qa");
  expect(() => registry.get("dev")).toThrow(
    "Unknown runtime environment profile: dev",
  );
});

test.each(["busy", "external"])(
  "a removed %s owner is protected and metadata remains the applied snapshot",
  async (state) => {
    await registry.start(["prod", "dev"]);
    const removed = owners[1]!;
    if (state === "busy") removed.isOwnerIdle.mockReturnValue(false);
    else removed.getOwnership.mockReturnValue("client");
    await setProfiles(["prod"]);
    expect(await registry.applyConfiguration()).toMatchObject({
      status: "restart_required",
    });
    expect(removed.stopIfIdle).not.toHaveBeenCalled();
    expect(
      registry.environmentConfig()!.environments.map(({ id }) => id),
    ).toEqual(["prod", "dev"]);
  },
);

test("a previously failed startup is retried only while its profile remains configured", async () => {
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  const failed = registry.get("dev");
  const error = new Error("startup_failed");
  vi.mocked(failed.start).mockRejectedValue(error);
  await registry.start(["prod", "dev"]);
  await setProfiles(["prod"]);
  expect(await registry.applyConfiguration()).toEqual({ status: "ready" });
  expect(failed.stop).toHaveBeenCalledOnce();
  expect(
    registry.environmentConfig()!.environments.map(({ id }) => id),
  ).toEqual(["prod"]);
  logging.mockRestore();
});


test("Web environments only request a Socket connection when the caller opts in", async () => {
  await registry.start(["prod", "dev"]);
  const calls = vi.mocked(createLocalRuntimeApplication).mock.calls;
  expect(calls).toHaveLength(2);
  for (const [, options] of calls) expect(options).not.toHaveProperty("bridge");
});

test.each([false, true])("Socket binding follows the new default on apply and the prior default on rollback (fail: %s)", async (fail) => {
  const binding = (runtimeId: string) => ({ runtimeId, url: "wss://relay.example.test", token: "test-only" });
  const runtimeBridge = vi.fn((config: RuntimeConfig, target: string) =>
    config.runtimeId === target ? binding(target) : undefined);
  registry = new RuntimeEnvironmentRegistry({
    ...options, runtimeBridge,
    onRuntimeSetup: async () => {
      if (fail) throw new Error("fixture activation failed");
      return { status: "ready" };
    },
  });
  await registry.start(["prod", "dev"]);
  await setProfiles(["prod", "dev"], "dev");
  if (fail) await expect(registry.applyConfiguration()).rejects.toThrow("fixture activation failed");
  else await expect(registry.applyConfiguration()).resolves.toMatchObject({ status: "ready" });

  const phases = vi.mocked(createLocalRuntimeApplication).mock.calls.map(
    ([config, options]) => [config!.runtimeId, options?.bridge],
  );
  const initial = [["prod", binding("prod")], ["dev", undefined]];
  const replacement = [["prod", undefined], ["dev", binding("dev")]];
  expect(phases).toEqual([...initial, ...replacement, ...(fail ? initial : [])]);
  for (const oldOwner of owners.slice(0, 2)) expect(oldOwner.stopIfIdle).toHaveBeenCalledOnce();
  expect(registry.get("prod")).not.toBe(owners[0]);
  expect(registry.get("dev")).not.toBe(owners[1]);
  expect(registry.profileEnv("").LLM_RUNTIME_PROFILE).toBe(fail ? "prod" : "dev");
});

test("invalid Socket configuration keeps the local environment available and logs no binding data", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    registry = new RuntimeEnvironmentRegistry({
      ...options,
      runtimeBridge: () => { throw new Error("test credential and path"); },
    });
    await registry.start(["prod"]);
    expect(owners[0]!.start).toHaveBeenCalledOnce();
    expect(vi.mocked(createLocalRuntimeApplication).mock.calls[0]![1]).not.toHaveProperty("bridge");
    expect(warning).toHaveBeenCalledExactlyOnceWith("Socket connection configuration needs attention.");
  } finally {
    warning.mockRestore();
  }
});
