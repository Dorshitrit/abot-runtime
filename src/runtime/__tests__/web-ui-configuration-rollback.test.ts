import { describe, expect, test, vi } from "vitest";
import type { LocalRuntimeApplication } from "../local-application.js";
import type { RuntimeConfig } from "../ports.js";
import { applyRuntimeConfiguration } from "../../web-ui/local-runtime/configuration-activation.js";

function environment(
  label: string,
  order: string[],
  config = { label } as unknown as RuntimeConfig,
) {
  let stopped = false;
  return {
    services: { config },
    start: vi.fn(async () => {
      if (stopped) throw new Error("local_runtime_stopped");
      order.push(`start:${label}`);
    }),
    getOwnership: () => (stopped ? undefined : "owner"),
    isOwnerIdle: () => !stopped,
    stopIfIdle: vi.fn(async () => {
      stopped = true;
      order.push(`idle-close:${label}`);
      return true;
    }),
    stop: vi.fn(async () => {
      stopped = true;
      order.push(`stop:${label}`);
    }),
  } as unknown as LocalRuntimeApplication;
}

function fixture() {
  const order: string[] = [];
  const previous = new Map([
    ["prod", environment("old-prod", order)],
    ["dev", environment("old-dev", order)],
  ]);
  const environments = new Map(previous);
  const candidates = new Map([
    ["prod", environment("new-prod", order)],
    ["qa", environment("new-qa", order)],
  ]);
  const restored = new Map<string, LocalRuntimeApplication>();
  const recreateEnvironment = vi.fn(
    (id: string, old: LocalRuntimeApplication) => {
      const replacement = environment(
        `restored-${id}`,
        order,
        old.services.config,
      );
      restored.set(id, replacement);
      return replacement;
    },
  );
  const restoreGateway = vi.fn(async () => {
    order.push("restore-gateway");
  });
  const createGatewayRestorePoint = vi.fn(() => ({ restore: restoreGateway }));
  return {
    previous,
    candidates,
    restored,
    order,
    restoreGateway,
    recreateEnvironment,
    options: {
      environments,
      defaultEnvironmentId: "prod",
      environmentIds: ["prod", "qa"],
      createEnvironment: (id: string) => candidates.get(id)!,
      recreateEnvironment,
      createGatewayRestorePoint,
    },
  };
}

function expectPreviousOwnersRestored(state: ReturnType<typeof fixture>) {
  expect([...state.options.environments.keys()]).toEqual(["prod", "dev"]);
  for (const [id, previous] of state.previous) {
    const restored = state.options.environments.get(id)!;
    expect(restored).not.toBe(previous);
    expect(restored).toBe(state.restored.get(id));
    expect(restored.services.config).toBe(previous.services.config);
    expect(previous.start).toHaveBeenCalledOnce();
    expect(previous.stopIfIdle).toHaveBeenCalledOnce();
    expect(restored.start).toHaveBeenCalledOnce();
    expect(state.order.indexOf("restore-gateway")).toBeLessThan(
      state.order.indexOf(`start:restored-${id}`),
    );
  }
}

describe("failed Apply restores previous idle owners", () => {
  test("gateway activation failure preserves the error and recreates stopped owners from their applied configurations", async () => {
    const state = fixture();
    const failure = new Error("candidate_gateway_failed");
    await expect(
      applyRuntimeConfiguration({
        ...state.options,
        activateGateway: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(state.restoreGateway).toHaveBeenCalledOnce();
    expectPreviousOwnersRestored(state);
    for (const candidate of state.candidates.values())
      expect(candidate.start).not.toHaveBeenCalled();
  });

  test("a late restart-required result retains its message and restores previous membership", async () => {
    const state = fixture();
    const pending = {
      status: "restart_required" as const,
      message: "A new external gateway now owns the requested endpoint.",
    };
    const result = await applyRuntimeConfiguration({
      ...state.options,
      activateGateway: async () => pending,
    });
    expect(result).toBe(pending);
    expectPreviousOwnersRestored(state);
  });

  test("partial replacement startup closes every candidate before gateway and environment restoration", async () => {
    const state = fixture();
    const failure = new Error("new_profile_start_failed");
    vi.mocked(state.candidates.get("qa")!.start).mockRejectedValue(failure);
    await expect(
      applyRuntimeConfiguration({
        ...state.options,
        activateGateway: async () => ({ status: "ready" }),
      }),
    ).rejects.toBe(failure);
    expectPreviousOwnersRestored(state);
    for (const [id, candidate] of state.candidates) {
      expect(candidate.stop).toHaveBeenCalledOnce();
      expect(state.order.indexOf(`stop:new-${id}`)).toBeLessThan(
        state.order.indexOf("restore-gateway"),
      );
    }
    expect(state.options.environments.has("qa")).toBe(false);
  });

  test("a failed gateway restoration reports both failures without starting old wrappers against the candidate gateway", async () => {
    const state = fixture();
    const failure = new Error("candidate_failed");
    const restorationFailure = new Error("previous_gateway_unavailable");
    state.restoreGateway.mockRejectedValue(restorationFailure);
    const result = await applyRuntimeConfiguration({
      ...state.options,
      activateGateway: async () => {
        throw failure;
      },
    }).catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toContain(failure);
    expect(result.errors).toContain(restorationFailure);
    expect(state.options.environments.size).toBe(0);
    expect(state.recreateEnvironment).not.toHaveBeenCalled();
  });

  test("shutdown during failed activation prevents gateway or owner revival", async () => {
    const state = fixture();
    let running = true;
    await expect(
      applyRuntimeConfiguration({
        ...state.options,
        canContinue: () => running,
        activateGateway: async () => {
          running = false;
          throw new Error("gateway_closed");
        },
      }),
    ).rejects.toThrow();
    expect(state.restoreGateway).not.toHaveBeenCalled();
    expect(state.recreateEnvironment).not.toHaveBeenCalled();
    expect(state.options.environments.size).toBe(0);
  });

  test("shutdown arriving during gateway restoration prevents old environment startup", async () => {
    const state = fixture();
    let running = true;
    state.restoreGateway.mockImplementation(async () => {
      running = false;
    });
    await expect(
      applyRuntimeConfiguration({
        ...state.options,
        canContinue: () => running,
        activateGateway: async () => {
          throw new Error("candidate_failed");
        },
      }),
    ).rejects.toThrow();
    for (const owner of state.restored.values())
      expect(owner.start).not.toHaveBeenCalled();
    expect(state.options.environments.size).toBe(0);
  });
});
