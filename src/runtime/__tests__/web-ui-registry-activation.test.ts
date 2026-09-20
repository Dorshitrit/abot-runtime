import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LocalRuntimeApplication } from "../local-application.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadRuntimeConfig: () => ({}) }));
vi.mock("../model/model-catalog.js", () => ({
  loadRuntimeModelCatalog: () => ({
    defaultProfileId: "example",
    profiles: [{ id: "example" }],
  }),
}));
vi.mock("../../web-ui/local-runtime/runtime-availability.js", () => ({
  inspectRuntimeSetupRequirement: () => null,
}));
vi.mock("../../web-ui/local-runtime/runtime-setup-provider.js", () => ({
  requiresConfiguredCredential: () => false,
}));

const roots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function environment() {
  return {
    services: { config: {} },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getOwnership: () => "owner",
    isOwnerIdle: () => true,
    stopIfIdle: vi.fn(async () => true),
    subscribeScheduledEvents: vi.fn(),
  } as unknown as LocalRuntimeApplication;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((callback) => {
    resolve = callback;
  });
  return { promise, resolve };
}

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "web-registry-activation-"));
  roots.push(rootDir);
  const configPath = join(rootDir, "runtime.config.json");
  await writeFile(configPath, "{}");
  return { rootDir, configPath, defaultEnvironmentId: "prod" };
}

describe("Web runtime configuration lifecycle", () => {
  test("concurrent Apply calls share one operation and Stop fences gateway and replacement startup", async () => {
    const options = await fixture();
    const old = environment();
    vi.mocked(createLocalRuntimeApplication).mockReturnValue(old);
    const gate = deferred<{ status: "ready" }>();
    const checked = deferred<void>();
    const activateGateway = vi.fn(async () => ({ status: "ready" as const }));
    const registry = new RuntimeEnvironmentRegistry({
      ...options,
      checkRuntimeSetupActivation: () => {
        checked.resolve();
        return gate.promise;
      },
      onRuntimeSetup: activateGateway,
    });
    registry.get("prod");
    const applying = registry.applyConfiguration();
    expect(registry.applyConfiguration()).toBe(applying);
    await checked.promise;
    const stopping = registry.stop();
    gate.resolve({ status: "ready" });
    await expect(applying).rejects.toThrow("web_runtime_stopped");
    await stopping;
    expect(activateGateway).not.toHaveBeenCalled();
    expect(createLocalRuntimeApplication).toHaveBeenCalledOnce();
    expect(old.stop).toHaveBeenCalledOnce();
    expect(old.stopIfIdle).not.toHaveBeenCalled();
    await expect(registry.applyConfiguration()).rejects.toThrow(
      "web_runtime_stopped",
    );
  });

  test("Stop during gateway activation cannot leave a new environment running", async () => {
    const options = await fixture();
    const old = environment();
    const fresh = environment();
    vi.mocked(createLocalRuntimeApplication)
      .mockReturnValueOnce(old)
      .mockReturnValue(fresh);
    const gate = deferred<{ status: "ready" }>();
    const activated = deferred<void>();
    const registry = new RuntimeEnvironmentRegistry({
      ...options,
      onRuntimeSetup: () => {
        activated.resolve();
        return gate.promise;
      },
    });
    registry.get("prod");
    const applying = registry.applyConfiguration();
    await activated.promise;
    const stopping = registry.stop();
    gate.resolve({ status: "ready" });
    await expect(applying).rejects.toThrow("web_runtime_stopped");
    await stopping;
    expect(old.stopIfIdle).toHaveBeenCalledOnce();
    expect(fresh.start).not.toHaveBeenCalled();
  });

  test("first setup stays blocked after saving until explicit application succeeds", async () => {
    const options = await fixture();
    vi.mocked(createLocalRuntimeApplication).mockImplementation(() =>
      environment(),
    );
    let gatewayReady = false;
    const registry = new RuntimeEnvironmentRegistry({
      ...options,
      checkRuntimeSetupActivation: async () =>
        gatewayReady
          ? { status: "ready" }
          : { status: "restart_required", message: "External gateway" },
      onRuntimeSetup: async () => ({ status: "ready" }),
    });
    registry.configure(options.configPath);
    expect((await registry.applyConfiguration()).status).toBe(
      "restart_required",
    );
    expect(registry.modelCatalog("prod").availability.status).toBe(
      "setup_required",
    );
    expect(registry.modelCatalog("prod").profiles).toEqual([]);
    gatewayReady = true;
    expect((await registry.applyConfiguration()).status).toBe("ready");
    expect(registry.modelCatalog("prod").availability.status).toBe("ready");
    expect(registry.modelCatalog("prod").profiles).toHaveLength(1);
  });

  test("pending changes do not hide an existing running environment", async () => {
    const options = await fixture();
    const old = environment();
    vi.mocked(createLocalRuntimeApplication).mockReturnValue(old);
    const registry = new RuntimeEnvironmentRegistry(options);
    registry.get("prod");
    await old.start();
    registry.configure(options.configPath);
    expect((await registry.applyConfiguration()).status).toBe(
      "restart_required",
    );
    expect(registry.modelCatalog("prod").availability.status).toBe("ready");
    expect(old.stopIfIdle).not.toHaveBeenCalled();
  });
});
