import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalRuntimeApplication } from "../local-application.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));
vi.mock("../config.js", () => ({
  loadRuntimeConfig: vi.fn(({ profileId }: { profileId: string }) => ({
    runtimeId: profileId,
  })),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRegistryFixture() {
  const slow = deferred();
  const stopSlow = deferred();
  const environments = {
    slow: {
      start: vi.fn(() => slow.promise),
      stop: vi.fn(() => stopSlow.promise),
    },
    healthy: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
  };
  vi.mocked(createLocalRuntimeApplication).mockImplementation(
    (config) =>
      environments[
        config!.runtimeId as keyof typeof environments
      ] as unknown as ReturnType<typeof createLocalRuntimeApplication>,
  );
  const registry = new RuntimeEnvironmentRegistry({
    defaultEnvironmentId: "healthy",
  });
  const setup = vi.spyOn(registry, "setupRequirement").mockReturnValue(null);
  return { registry, setup, slow, stopSlow, environments };
}

beforeEach(() => {
  vi.mocked(createLocalRuntimeApplication).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("independent Web environment startup", () => {
  it("starts healthy environments while another owner is still pending and awaits every result before shutdown", async () => {
    const { registry, slow, stopSlow, environments } = createRegistryFixture();
    const startup = registry.start(["slow", "healthy"]);
    const started = vi.fn();
    void startup.then(started);
    await Promise.resolve();
    expect(environments.healthy.start).toHaveBeenCalledTimes(1);
    expect(started).not.toHaveBeenCalled();

    const shutdown = startup.then(() => registry.stop());
    expect(environments.healthy.stop).not.toHaveBeenCalled();
    slow.resolve();
    await startup;
    await Promise.resolve();
    expect(environments.slow.stop).toHaveBeenCalledTimes(1);
    expect(environments.healthy.stop).toHaveBeenCalledTimes(1);
    const stopped = vi.fn();
    void shutdown.then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    stopSlow.resolve();
    await shutdown;
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("isolates an owner startup failure from healthy environment startup", async () => {
    const error = new Error("local_runtime_owner_start_timeout");
    const logging = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, slow, environments } = createRegistryFixture();
    const startup = registry.start(["slow", "healthy"]);
    expect(environments.healthy.start).toHaveBeenCalledTimes(1);
    slow.reject(error);
    await startup;
    expect(logging).toHaveBeenCalledExactlyOnceWith(
      "Scheduler unavailable for environment slow:",
      error,
    );
  });

  it("continues past setup requirements and synchronous configuration failures", async () => {
    const logging = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, setup, environments } = createRegistryFixture();
    const failure = new Error("invalid_environment_configuration");
    setup.mockImplementation((id) => {
      if (id === "invalid") throw failure;
      if (id === "unconfigured")
        return {
          status: "setup_required",
          code: "runtime_configuration_required",
          message: "Setup required",
        };
      return null;
    });
    await registry.start(["invalid", "unconfigured", "healthy"]);
    expect(environments.healthy.start).toHaveBeenCalledTimes(1);
    expect(createLocalRuntimeApplication).toHaveBeenCalledTimes(1);
    expect(logging).toHaveBeenCalledExactlyOnceWith(
      "Scheduler unavailable for environment invalid:",
      failure,
    );
  });
});
