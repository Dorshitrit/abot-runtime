import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplication,
} from "../local-application.js";
import { loadRuntimeConfig } from "../config.js";
import { loadRuntimeModelCatalog } from "../model/model-catalog.js";
import type { RuntimeConfig } from "../ports.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadRuntimeConfig: vi.fn() }));
vi.mock("../model/model-catalog.js", () => ({
  loadRuntimeModelCatalog: (config: RuntimeConfig) => {
    const ids = Object.keys(config.models?.profiles ?? {});
    return { defaultProfileId: ids[0], profiles: ids.map((id) => ({ id })) };
  },
}));
vi.mock("../../web-ui/local-runtime/runtime-availability.js", () => ({
  inspectRuntimeSetupRequirement: () => null,
}));
vi.mock("../../web-ui/local-runtime/runtime-setup-provider.js", () => ({
  requiresConfiguredCredential: () => false,
}));
vi.mock("../../web-ui/local-runtime/saved-model-catalog.js", () => ({
  readSavedModelCatalog: (_source: unknown, environmentId: string) =>
    loadRuntimeModelCatalog(loadRuntimeConfig({ profileId: environmentId })),
}));

const owners: ReturnType<typeof environment>[] = [];
let rootDir = "";
let registry: RuntimeEnvironmentRegistry | undefined;
function environment(config: RuntimeConfig) {
  let closed = false;
  return {
    services: { config },
    start: vi.fn(async () => {
      if (closed) throw new Error("local_runtime_stopped");
    }),
    stop: vi.fn(async () => {
      closed = true;
    }),
    getOwnership: () => (closed ? undefined : ("owner" as const)),
    isOwnerIdle: () => !closed,
    stopIfIdle: vi.fn(async () => {
      closed = true;
      return true;
    }),
    subscribeScheduledEvents: vi.fn(),
  };
}
function configuration(modelId: string): RuntimeConfig {
  return {
    models: { profiles: { [modelId]: {} } },
  } as unknown as RuntimeConfig;
}
function metadata(ids: string[], defaultEnvironmentId = ids[0]!) {
  return {
    defaultEnvironmentId,
    environments: ids.map((id) => ({
      id,
      label: id,
      isDefault: id === defaultEnvironmentId,
    })),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  owners.splice(0);
  const artifacts = resolve(
    ".codex/artifacts/pr71-second-review-20260908/activation",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "fixture-"));
  await writeFile(join(rootDir, "runtime.config.json"), "{}");
  vi.mocked(createLocalRuntimeApplication).mockImplementation((config) => {
    const owner = environment(config!);
    owners.push(owner);
    return owner as unknown as LocalRuntimeApplication;
  });
});
afterEach(async () => {
  await registry?.stop();
  registry = undefined;
  await rm(rootDir, { recursive: true, force: true });
});

async function fixture(
  onRuntimeSetup: () => Promise<{
    status: "ready" | "restart_required";
    message?: string;
  }>,
  createRuntimeSetupRestorePoint?: () => { restore(): Promise<void> },
) {
  const previousConfig = new Map([
    ["prod", configuration("previous-prod-model")],
    ["dev", configuration("previous-dev-model")],
  ]);
  let savedConfig = previousConfig;
  let currentMetadata = metadata(["prod", "dev"]);
  vi.mocked(loadRuntimeConfig).mockImplementation((options) => {
    const config = savedConfig.get(options?.profileId || "prod");
    if (!config) throw new Error("Unknown runtime environment profile");
    return config;
  });
  const publish = vi.fn();
  const requestOptions = () => ({});
  registry = new RuntimeEnvironmentRegistry(
    {
      rootDir,
      configPath: join(rootDir, "runtime.config.json"),
      defaultEnvironmentId: "prod",
      resolveEnvironmentConfig: () => currentMetadata,
      onRuntimeSetup,
      createRuntimeSetupRestorePoint,
    },
    { publish, requestOptions },
  );
  await registry.start(["prod", "dev"]);
  const previousOwners = [...owners];
  const desiredConfig = new Map([
    ["prod", configuration("desired-prod-model")],
    ["qa", configuration("desired-qa-model")],
  ]);
  savedConfig = desiredConfig;
  currentMetadata = metadata(["prod", "qa"], "qa");
  return {
    previousConfig,
    desiredConfig,
    previousOwners,
    registry,
    publish,
    requestOptions,
  };
}

test.each(["throw", "pending"] as const)(
  "%s after closure restores applied config, catalog, metadata, and scheduler subscriptions before a later explicit retry",
  async (failureKind) => {
    const failure = new Error("gateway_activation_failed");
    const pending = {
      status: "restart_required" as const,
      message: "Gateway ownership changed.",
    };
    let shouldFail = true;
    const state = await fixture(async () => {
      if (!shouldFail) return { status: "ready" };
      if (failureKind === "throw") throw failure;
      return pending;
    });
    const apply = state.registry.applyConfiguration();
    if (failureKind === "throw") await expect(apply).rejects.toBe(failure);
    else expect(await apply).toBe(pending);
    for (const [index, id] of ["prod", "dev"].entries()) {
      const restored = state.registry.get(id);
      expect(restored).not.toBe(state.previousOwners[index]);
      expect(restored.services.config).toBe(state.previousConfig.get(id));
      expect(restored.start).toHaveBeenCalledOnce();
      expect(restored.subscribeScheduledEvents).toHaveBeenCalledWith(
        state.publish,
      );
      expect(createLocalRuntimeApplication).toHaveBeenCalledWith(
        state.previousConfig.get(id),
        { scheduledRequestOptions: state.requestOptions },
      );
    }
    expect(state.registry.environmentConfig()).toEqual(
      metadata(["prod", "dev"]),
    );
    expect(state.registry.profileEnv("").LLM_RUNTIME_PROFILE).toBe("prod");
    expect(state.registry.modelCatalog("prod").defaultProfileId).toBe(
      "previous-prod-model",
    );
    expect(state.registry.modelCatalog("dev").defaultProfileId).toBe(
      "previous-dev-model",
    );
    shouldFail = false;
    expect(await state.registry.applyConfiguration()).toEqual({
      status: "ready",
    });
    expect(state.registry.get("prod").services.config).toBe(
      state.desiredConfig.get("prod"),
    );
    expect(state.registry.get("qa").services.config).toBe(
      state.desiredConfig.get("qa"),
    );
    expect(state.registry.environmentConfig()).toEqual(
      metadata(["prod", "qa"], "qa"),
    );
    expect(state.registry.modelCatalog("prod").defaultProfileId).toBe(
      "desired-prod-model",
    );
  },
);

test("Stop during a rejected gateway activation does not recreate stopped owners", async () => {
  let rejectGateway!: (error: Error) => void;
  let entered!: () => void;
  const enteredGateway = new Promise<void>((done) => {
    entered = done;
  });
  const gate = new Promise<{ status: "ready" }>((_resolve, reject) => {
    rejectGateway = reject;
  });
  const state = await fixture(() => {
    entered();
    return gate;
  });
  const applying = state.registry.applyConfiguration();
  const rejected = expect(applying).rejects.toThrow();
  await enteredGateway;
  const stopping = state.registry.stop();
  rejectGateway(new Error("gateway_closed"));
  await rejected;
  await stopping;
  expect(owners).toHaveLength(4);
  for (const candidate of owners.slice(2))
    expect(candidate.start).not.toHaveBeenCalled();
  expect(() => state.registry.get("prod")).toThrow("web_runtime_stopped");
});

test("failed restoration keeps catalog unavailable until a later explicit Apply succeeds", async () => {
  const originalFailure = new Error("candidate_gateway_failed");
  const restorationFailure = new Error("previous_gateway_unavailable");
  let shouldFail = true;
  const state = await fixture(
    async () => {
      if (shouldFail) throw originalFailure;
      return { status: "ready" };
    },
    () => ({
      restore: async () => {
        throw restorationFailure;
      },
    }),
  );
  const failure = await state.registry
    .applyConfiguration()
    .catch((error) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toContain(originalFailure);
  expect(failure.errors).toContain(restorationFailure);
  expect(state.registry.modelCatalog("prod")).toMatchObject({
    availability: { status: "setup_required" },
    profiles: [],
  });
  shouldFail = false;
  expect(await state.registry.applyConfiguration()).toEqual({
    status: "ready",
  });
  expect(state.registry.modelCatalog("prod")).toMatchObject({
    availability: { status: "ready" },
    defaultProfileId: "desired-prod-model",
  });
});

test("uncertain idle shutdown gates the catalog while confirmed closed owners recover and explicit Apply remains retryable", async () => {
  const activateGateway = vi.fn(async () => ({ status: "ready" as const }));
  const restoreGateway = vi.fn(async () => {});
  const state = await fixture(activateGateway, () => ({
    restore: restoreGateway,
  }));
  const uncertain = state.previousOwners[1]!;
  const failure = new Error("owner_shutdown_failed");
  uncertain.stopIfIdle.mockRejectedValueOnce(failure);

  await expect(state.registry.applyConfiguration()).rejects.toBe(failure);

  const restored = state.registry.get("prod");
  expect(restored).not.toBe(state.previousOwners[0]);
  expect(restored.services.config).toBe(state.previousConfig.get("prod"));
  expect(state.registry.get("dev")).toBe(uncertain);
  expect(uncertain.stop).not.toHaveBeenCalled();
  expect(activateGateway).not.toHaveBeenCalled();
  expect(restoreGateway).not.toHaveBeenCalled();
  for (const id of ["prod", "dev"]) {
    expect(state.registry.modelCatalog(id)).toMatchObject({
      availability: { status: "setup_required" },
      profiles: [],
    });
  }
  expect(state.registry.environmentConfig()).toEqual(metadata(["prod", "dev"]));

  expect(await state.registry.applyConfiguration()).toEqual({
    status: "ready",
  });
  expect(state.registry.modelCatalog("prod")).toMatchObject({
    availability: { status: "ready" },
    defaultProfileId: "desired-prod-model",
  });
  expect(state.registry.environmentConfig()).toEqual(
    metadata(["prod", "qa"], "qa"),
  );
});
