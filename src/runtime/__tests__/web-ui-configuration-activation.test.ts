import { describe, expect, test, vi } from "vitest";
import type { LocalRuntimeApplication } from "../local-application.js";
import { applyRuntimeConfiguration } from "../../web-ui/local-runtime/configuration-activation.js";

function environment(
  ownership: "owner" | "client" | undefined = "owner",
  idle = true,
) {
  return {
    start: vi.fn(async () => {}),
    getOwnership: () => ownership,
    isOwnerIdle: () => idle,
    stopIfIdle: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
  } as unknown as LocalRuntimeApplication;
}

describe("applying saved Web configuration", () => {
  test.each(["busy", "external"] as const)(
    "%s environments preserve all owners and do not restart gateway",
    async (reason) => {
      const first = environment();
      const blocked = environment(
        reason === "external" ? "client" : "owner",
        reason !== "busy",
      );
      const createEnvironment = vi.fn(() => environment());
      const activateGateway = vi.fn(async () => ({ status: "ready" as const }));
      const environments = new Map([
        ["prod", first],
        ["dev", blocked],
      ]);
      const result = await applyRuntimeConfiguration({
        environments,
        defaultEnvironmentId: "prod",
        createEnvironment,
        recreateEnvironment: () => environment(),
        activateGateway,
      });
      expect(result.status).toBe("restart_required");
      expect(first.stopIfIdle).not.toHaveBeenCalled();
      expect(blocked.stopIfIdle).not.toHaveBeenCalled();
      expect(createEnvironment).not.toHaveBeenCalled();
      expect(activateGateway).not.toHaveBeenCalled();
      expect(environments.get("prod")).toBe(first);
    },
  );

  test("invalid replacement configuration leaves the live instance intact", async () => {
    const current = environment();
    const environments = new Map([["prod", current]]);
    await expect(
      applyRuntimeConfiguration({
        environments,
        defaultEnvironmentId: "prod",
        createEnvironment: () => {
          throw new Error("invalid_config");
        },
        recreateEnvironment: () => environment(),
        activateGateway: async () => ({ status: "ready" }),
      }),
    ).rejects.toThrow("invalid_config");
    expect(current.stopIfIdle).not.toHaveBeenCalled();
    expect(environments.get("prod")).toBe(current);
  });

  test("idle owners close before gateway refresh and replacement startup", async () => {
    const order: string[] = [];
    const old = environment();
    const fresh = environment();
    vi.mocked(old.stopIfIdle).mockImplementation(async () => {
      order.push("closed");
      return true;
    });
    vi.mocked(fresh.start).mockImplementation(async () => {
      order.push("started");
    });
    const environments = new Map([["prod", old]]);
    const result = await applyRuntimeConfiguration({
      environments,
      defaultEnvironmentId: "prod",
      createEnvironment: () => fresh,
      recreateEnvironment: () => environment(),
      activateGateway: async () => {
        order.push("gateway");
        return { status: "ready" };
      },
    });
    expect(result.status).toBe("ready");
    expect(order).toEqual(["closed", "gateway", "started"]);
    expect(environments.get("prod")).toBe(fresh);
  });

  test("an external gateway is detected before healthy owners close", async () => {
    const old = environment();
    const gateway = vi.fn(async () => ({ status: "ready" as const }));
    const result = await applyRuntimeConfiguration({
      environments: new Map([["prod", old]]),
      defaultEnvironmentId: "prod",
      createEnvironment: () => environment(),
      checkGateway: async () => ({
        status: "restart_required",
        message: "External gateway",
      }),
      recreateEnvironment: () => environment(),
      activateGateway: gateway,
    });
    expect(result.status).toBe("restart_required");
    expect(old.stopIfIdle).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });

  test("owner activity appearing during gateway preflight blocks closure", async () => {
    const old = environment();
    const idle = vi.spyOn(old, "isOwnerIdle").mockReturnValue(true);
    const result = await applyRuntimeConfiguration({
      environments: new Map([["prod", old]]),
      defaultEnvironmentId: "prod",
      createEnvironment: () => environment(),
      checkGateway: async () => {
        idle.mockReturnValue(false);
        return { status: "ready" };
      },
      recreateEnvironment: () => environment(),
      activateGateway: async () => ({ status: "ready" }),
    });
    expect(result.status).toBe("restart_required");
    expect(old.stopIfIdle).not.toHaveBeenCalled();
  });

  test("a cached failed startup is retired before corrected configuration is started", async () => {
    const stale = environment();
    const startupError = new Error("old invalid plugin");
    vi.mocked(stale.start).mockRejectedValue(startupError);
    vi.mocked(stale.stop).mockRejectedValue(startupError);
    const fresh = environment();
    const environments = new Map([["prod", stale]]);
    const result = await applyRuntimeConfiguration({
      environments,
      defaultEnvironmentId: "prod",
      createEnvironment: () => fresh,
      recreateEnvironment: () => environment(),
      activateGateway: async () => ({ status: "ready" }),
    });
    expect(result.status).toBe("ready");
    expect(stale.stop).toHaveBeenCalledOnce();
    expect(stale.stopIfIdle).not.toHaveBeenCalled();
    expect(fresh.start).toHaveBeenCalledOnce();
    expect(environments.get("prod")).toBe(fresh);
  });

  test("partial startup failure closes candidates and retains desired environments for retry", async () => {
    const first = environment();
    const failed = environment();
    const startupError = new Error("plugin entrypoint missing");
    vi.mocked(failed.start).mockRejectedValue(startupError);
    vi.mocked(failed.stop).mockRejectedValue(startupError);
    const environments = new Map<string, LocalRuntimeApplication>();
    const environmentIds = ["prod", "dev"];
    const options = {
      environments,
      environmentIds,
      defaultEnvironmentId: "prod",
      createEnvironment: (id: string) => (id === "prod" ? first : failed),
      recreateEnvironment: () => environment(),
      activateGateway: async () => ({ status: "ready" as const }),
    };
    await expect(applyRuntimeConfiguration(options)).rejects.toThrow(
      "plugin entrypoint missing",
    );
    expect(environments.has("prod")).toBe(false);
    expect(environments.has("dev")).toBe(false);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(failed.stop).toHaveBeenCalledOnce();

    const recovered = new Map([
      ["prod", environment()],
      ["dev", environment()],
    ]);
    const result = await applyRuntimeConfiguration({
      ...options,
      createEnvironment: (id) => recovered.get(id)!,
    });
    expect(result.status).toBe("ready");
    expect([...environments.keys()]).toEqual(environmentIds);
    expect(recovered.get("dev")!.start).toHaveBeenCalledOnce();
  });

  test("shutdown after gateway refresh prevents replacement startup", async () => {
    const old = environment();
    const fresh = environment();
    const environments = new Map([["prod", old]]);
    let running = true;
    await expect(
      applyRuntimeConfiguration({
        environments,
        defaultEnvironmentId: "prod",
        createEnvironment: () => fresh,
        canContinue: () => running,
        recreateEnvironment: () => environment(),
        activateGateway: async () => {
          running = false;
          return { status: "ready" };
        },
      }),
    ).rejects.toThrow("web_runtime_stopped");
    expect(fresh.start).not.toHaveBeenCalled();
    expect(environments.size).toBe(0);
  });
});
