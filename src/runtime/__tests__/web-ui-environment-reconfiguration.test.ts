import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplication,
} from "../local-application.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { resolveWebUiEnvironmentConfig } from "../../web-ui/environment-config.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));

let rootDir = "";
let configPath = "";
let registry: RuntimeEnvironmentRegistry;
const owners: ReturnType<typeof environment>[] = [];

function environment() {
  return {
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
  vi.mocked(createLocalRuntimeApplication).mockImplementation(() => {
    const owner = environment();
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
  registry = new RuntimeEnvironmentRegistry({
    rootDir,
    configPath,
    defaultEnvironmentId: "prod",
    resolveEnvironmentConfig: (path) =>
      resolveWebUiEnvironmentConfig({ rootDir, configPath: path }),
    onRuntimeSetup: async () => ({ status: "ready" }),
  });
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
