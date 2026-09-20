import { expect, test, vi } from "vitest";
import type { LocalRuntimeApplication } from "../local-application.js";
import type { RuntimeConfig } from "../ports.js";
import { applyRuntimeConfiguration } from "../../web-ui/local-runtime/configuration-activation.js";

function environment(config: RuntimeConfig) {
  let stopped = false;
  return {
    services: { config },
    start: vi.fn(async () => {
      if (stopped) throw new Error("local_runtime_stopped");
    }),
    getOwnership: () => "owner",
    isOwnerIdle: () => !stopped,
    stopIfIdle: vi.fn(async () => {
      stopped = true;
      return true;
    }),
    stop: vi.fn(async () => {
      stopped = true;
    }),
  } as unknown as LocalRuntimeApplication;
}

function fixture(ids = ["prod", "dev"]) {
  let running = true;
  const previous = new Map(
    ids.map((id) => [id, environment({ id } as unknown as RuntimeConfig)]),
  );
  const environments = new Map(previous);
  const restoreGateway = vi.fn(async () => {});
  const recreateEnvironment = vi.fn(
    (_id: string, old: LocalRuntimeApplication) =>
      environment(old.services.config),
  );
  const options = {
    environments,
    defaultEnvironmentId: "prod",
    createEnvironment: vi.fn((id: string) =>
      environment({ candidate: id } as unknown as RuntimeConfig),
    ),
    recreateEnvironment,
    activateGateway: vi.fn(async () => ({ status: "ready" as const })),
    createGatewayRestorePoint: () => ({ restore: restoreGateway }),
    onRestorationFailure: vi.fn(),
    canContinue: () => running,
  };
  return {
    previous,
    options,
    restoreGateway,
    stop: () => {
      running = false;
    },
  };
}

function expectRestored(state: ReturnType<typeof fixture>, id: string) {
  const original = state.previous.get(id)!;
  const restored = state.options.environments.get(id)!;
  expect(restored).not.toBe(original);
  expect(restored.services.config).toBe(original.services.config);
  expect(restored.start).toHaveBeenCalledOnce();
  expect(original.start).toHaveBeenCalledOnce();
  expect(original.stop).not.toHaveBeenCalled();
}

function expectGatewayUntouched(state: ReturnType<typeof fixture>) {
  expect(state.options.activateGateway).not.toHaveBeenCalled();
  expect(state.restoreGateway).not.toHaveBeenCalled();
}

test("partial idle-close rejection restores only confirmed closed owners and preserves the primary failure", async () => {
  const state = fixture();
  const uncertain = state.previous.get("dev")!;
  const failure = new Error("owner_shutdown_failed");
  vi.mocked(uncertain.stopIfIdle).mockRejectedValue(failure);

  await expect(applyRuntimeConfiguration(state.options)).rejects.toBe(failure);

  expectRestored(state, "prod");
  expect(state.options.environments.get("dev")).toBe(uncertain);
  expect(uncertain.stop).not.toHaveBeenCalled();
  expect(state.options.recreateEnvironment).toHaveBeenCalledOnce();
  expect(state.options.onRestorationFailure).toHaveBeenCalled();
  expectGatewayUntouched(state);
});

test("late idle refusal preserves its original owner while restoring successfully closed siblings", async () => {
  const state = fixture();
  const refused = state.previous.get("dev")!;
  vi.mocked(refused.stopIfIdle).mockResolvedValue(false);

  await expect(applyRuntimeConfiguration(state.options)).rejects.toThrow(
    "Runtime ownership changed while applying configuration.",
  );

  expectRestored(state, "prod");
  expect(state.options.environments.get("dev")).toBe(refused);
  expect(refused.start).toHaveBeenCalledOnce();
  expect(refused.stop).not.toHaveBeenCalled();
  expect(state.options.recreateEnvironment).toHaveBeenCalledOnce();
  expect(state.options.onRestorationFailure).not.toHaveBeenCalled();
  expectGatewayUntouched(state);
});

test("a synchronous close failure still settles every owner and restores both confirmed closures", async () => {
  const state = fixture(["prod", "dev", "qa"]);
  const failure = new Error("synchronous_owner_shutdown_failed");
  const uncertain = state.previous.get("dev")!;
  vi.mocked(uncertain.stopIfIdle).mockImplementation(() => {
    throw failure;
  });

  await expect(applyRuntimeConfiguration(state.options)).rejects.toBe(failure);

  for (const id of ["prod", "qa"]) {
    expect(state.previous.get(id)!.stopIfIdle).toHaveBeenCalledOnce();
    expectRestored(state, id);
  }
  expect(state.options.environments.get("dev")).toBe(uncertain);
  expect(uncertain.stop).not.toHaveBeenCalled();
  expect(state.options.onRestorationFailure).toHaveBeenCalled();
  expectGatewayUntouched(state);
});

test("failed restoration preserves the close error and the restoration error without touching an uncertain owner", async () => {
  const state = fixture();
  const closeFailure = new Error("owner_shutdown_failed");
  const restoreFailure = new Error("previous_owner_unavailable");
  const uncertain = state.previous.get("dev")!;
  vi.mocked(uncertain.stopIfIdle).mockRejectedValue(closeFailure);
  state.options.recreateEnvironment.mockImplementation((_id, original) => {
    const restored = environment(original.services.config);
    vi.mocked(restored.start).mockRejectedValue(restoreFailure);
    return restored;
  });

  const failure = await applyRuntimeConfiguration(state.options).catch(
    (error) => error,
  );

  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toContain(closeFailure);
  expect(failure.errors).toContain(restoreFailure);
  expect(state.options.environments.has("prod")).toBe(false);
  expect(state.options.environments.get("dev")).toBe(uncertain);
  expect(uncertain.stop).not.toHaveBeenCalled();
  expect(state.options.onRestorationFailure).toHaveBeenCalled();
  expectGatewayUntouched(state);
});

test("shutdown during close settlement prevents owner restoration", async () => {
  const state = fixture();
  const failure = new Error("owner_shutdown_failed");
  let release!: () => void;
  let entered!: () => void;
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(state.previous.get("dev")!.stopIfIdle).mockImplementation(
    async () => {
      entered();
      await gate;
      throw failure;
    },
  );
  const applying = applyRuntimeConfiguration(state.options);
  const rejected = expect(applying).rejects.toBe(failure);
  await closing;
  state.stop();
  release();
  await rejected;

  expect(state.options.recreateEnvironment).not.toHaveBeenCalled();
  expect(state.options.environments.has("prod")).toBe(false);
  expectGatewayUntouched(state);
});
