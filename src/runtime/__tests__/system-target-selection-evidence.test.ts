import { describe, expect, test } from "vitest";
import { parseToolNormalInvocationContract } from "../../capabilities/normal-invocation/index.js";
import {
  linuxNativeTarget,
  requestConnectionId,
  requestHostId,
  systemRequestPluginFixture,
} from "./support/system-request-plugin-fixture.js";

describe("request-effective system capabilities omit connection selection", () => {
  test.each([1, 2, 3])(
    "prepared contracts remain valid with %i available OS targets",
    async (targetCount) => {
      const nativeTargets =
        targetCount === 3
          ? [
              linuxNativeTarget,
              {
                id: "macos" as const,
                transport: "native" as const,
                shell: "/bin/zsh",
              },
            ]
          : [linuxNativeTarget];
      const h = systemRequestPluginFixture(nativeTargets);
      const expectedTargets = [
        ...nativeTargets.map(({ id }) => id),
        ...(targetCount > 1 ? ["windows"] : []),
      ];
      if (targetCount === 1)
        h.readHostStatus.mockResolvedValue({ paired: false, connected: false });
      const modules = await h.prepare();
      expect(modules.length).toBeGreaterThan(0);
      for (const module of modules) {
        const parsed = parseToolNormalInvocationContract(
          module.definition.name,
          module.normalInvocation,
        );
        expect(parsed).toEqual(module.normalInvocation);
        for (const operation of parsed!.operations) {
          const target = operation.input.properties.target;
          if (target)
            expect(target).toEqual({ type: "string", enum: expectedTargets });
        }
      }
      expect(h.native).not.toHaveBeenCalled();
      expect(h.executeHostOperation).not.toHaveBeenCalled();
    },
  );

  test("Docker offers native Linux and connected Windows without connection identity", async () => {
    const h = systemRequestPluginFixture();
    const modules = await h.prepare();
    const catalog = modules.map(({ definition, normalInvocation }) => ({
      definition,
      normalInvocation,
    }));
    const serialized = JSON.stringify(catalog);
    for (const privateValue of [
      "host_id",
      "hostId",
      "connectionId",
      requestHostId,
      requestConnectionId,
      "Owner computer",
    ])
      expect(serialized).not.toContain(privateValue);
    for (const module of modules.filter(
      (entry) => entry.definition.name !== "system_targets",
    )) {
      expect(
        module.normalInvocation.operations[0]!.input.properties.target,
      ).toEqual({ type: "string", enum: ["linux", "windows"] });
    }
    const discovery = modules.find(
      (entry) => entry.definition.name === "system_targets",
    )!;
    const result = await discovery.implementation({});
    expect(result.data?.targets).toEqual([
      {
        id: "linux",
        available: true,
        transport: "native",
        commandExecutionStatus: "probed",
        availabilityScope: "command_execution_only",
        guiSessionStatus: "not_checked",
      },
      {
        id: "windows",
        available: true,
        transport: "host_companion",
        commandExecutionStatus: "not_probed",
        availabilityScope: "transport_connection_only",
        guiSessionStatus: "not_checked",
      },
    ]);
    for (const privateValue of [
      requestHostId,
      requestConnectionId,
      "Owner computer",
      "companion:",
    ])
      expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(h.executeHostOperation).not.toHaveBeenCalled();
    expect(h.native).not.toHaveBeenCalled();
  });

  test.each(["disconnected", "broker_missing", "malformed_identity"])(
    "%s removes Windows from the offered controls and rejects direct forged selection",
    async (condition) => {
      const h = systemRequestPluginFixture();
      if (condition === "broker_missing")
        h.readHostStatus.mockRejectedValue(new Error("No broker"));
      if (condition === "disconnected")
        h.readHostStatus.mockResolvedValue({
          paired: true,
          connected: false,
          hostId: requestHostId,
        });
      if (condition === "malformed_identity")
        h.readHostStatus.mockResolvedValue({
          paired: true,
          connected: true,
          hostId: requestHostId,
          connectionId: requestConnectionId,
          identity: { os: "windows", credential: "private-value" },
        } as never);
      const [module] = await h.prepare(["system_command"]);
      expect(
        module!.normalInvocation.operations[0]!.input.properties.target,
      ).toEqual({ type: "string", enum: ["linux"] });
      expect(JSON.stringify(module!.normalInvocation)).not.toContain("windows");
      expect(await module!.implementation({ target: "windows" })).toMatchObject(
        { ok: false, errorCode: "system_target_unavailable" },
      );
      expect(h.executeHostOperation).not.toHaveBeenCalled();
      expect(h.native).not.toHaveBeenCalled();
    },
  );

  test("no available OS route removes every system operation", async () => {
    const h = systemRequestPluginFixture([]);
    h.readHostStatus.mockResolvedValue({ paired: false, connected: false });
    expect(await h.prepare()).toEqual([]);
  });

  test("selected tools remain the only tools and do not require a discovery tool", async () => {
    const h = systemRequestPluginFixture();
    const modules = await h.prepare(["system_launch"]);
    expect(modules.map((module) => module.definition.name)).toEqual([
      "system_launch",
    ]);
    expect(
      await modules[0]!.implementation({
        target: "windows",
        application_id: "Fixture",
      }),
    ).toBe(h.remoteResult);
  });

  test("no selected tool causes no native or companion probes", async () => {
    const h = systemRequestPluginFixture();
    expect(await h.prepare([])).toEqual([]);
    expect(h.observeTargets).not.toHaveBeenCalled();
    expect(h.readHostStatus).not.toHaveBeenCalled();
  });
});
