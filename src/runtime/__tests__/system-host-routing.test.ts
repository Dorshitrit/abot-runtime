import { describe, expect, test, vi } from "vitest";
import { failureResult } from "../../plugin-sdk/index.js";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import type { SystemProcessRunner } from "../../computer-access/contracts.js";
import {
  connectedSystemHost,
  requestConnectionId,
  requestHostId,
  systemRequestPluginFixture,
} from "./support/system-request-plugin-fixture.js";

describe("system plugin binds implicit destinations before approval", () => {
  test.each(["system_command", "system_applications", "system_launch"])(
    "%s dispatches Windows through the captured companion without model connection input",
    async (operation) => {
      const h = systemRequestPluginFixture();
      const modules = await h.prepare();
      const module = modules.find(
        (entry) => entry.definition.name === operation,
      )!;
      const controller = new AbortController();
      const params = {
        target: "windows",
        cwd: "C:\\",
        command: "Get-Location",
        application_id: "Fixture",
      };
      expect(
        await module.implementation(params, { abortSignal: controller.signal }),
      ).toBe(h.remoteResult);
      expect(h.executeHostOperation).toHaveBeenCalledExactlyOnceWith(
        "/runtime",
        {
          hostId: requestHostId,
          connectionId: requestConnectionId,
          operation,
          params,
          abortSignal: controller.signal,
        },
      );
      expect(h.readHostStatus).toHaveBeenCalledOnce();
      expect(h.native).not.toHaveBeenCalled();
      const binding = module.adapter!.executionBinding!({
        tool: operation,
        params,
      });
      expect(binding.identity).toContain(requestConnectionId);
      expect(binding.metadata).toMatchObject({
        displayTarget: "windows",
        computerName: "Owner computer",
        transport: "host_companion",
      });
    },
  );

  test.each(["host_id", "hostId", "connectionId"])(
    "rejects externally authored %s without dispatch",
    async (field) => {
      const h = systemRequestPluginFixture();
      const [module] = await h.prepare(["system_command"]);
      expect(
        await module!.implementation({
          target: "windows",
          [field]: requestHostId,
        }),
      ).toMatchObject({
        ok: false,
        errorCode: "system_connection_control_forbidden",
      });
      expect(h.executeHostOperation).not.toHaveBeenCalled();
      expect(h.native).not.toHaveBeenCalled();
    },
  );

  test.each([
    { id: "linux", transport: "native", shell: "/bin/fixture-bash" },
    { id: "macos", transport: "native", shell: "/bin/fixture-bash" },
    {
      id: "windows",
      transport: "wsl_interop",
      shell: "/mnt/c/Windows/fixture-powershell.exe",
    },
  ] as const)(
    "preserves a captured native $id route before any companion alternative",
    async (target) => {
      const h = systemRequestPluginFixture([target]);
      const [module] = await h.prepare(["system_command"]);
      await module!.implementation({
        target: target.id,
        command: "fixture",
        cwd: "/",
      });
      expect(h.resolvedNativeTargets).toEqual([target]);
      expect(h.native).toHaveBeenCalledOnce();
      expect(h.executeHostOperation).not.toHaveBeenCalled();
      expect(h.observeTargets).toHaveBeenCalledOnce();
    },
  );

  test("a native failure does not reroute to a companion", async () => {
    const h = systemRequestPluginFixture([
      { id: "windows", transport: "wsl_interop", shell: "/observed-shell" },
    ]);
    h.native.mockResolvedValue(
      failureResult({
        errorCode: "system_target_unavailable",
        message: "Captured native route failed.",
      }),
    );
    const [module] = await h.prepare(["system_command"]);
    expect(await module!.implementation({ target: "windows" })).toMatchObject({
      ok: false,
      errorCode: "system_target_unavailable",
    });
    expect(h.executeHostOperation).not.toHaveBeenCalled();
  });

  test("a companion refusal or transport exception never causes native fallback or replay", async () => {
    const h = systemRequestPluginFixture();
    const [module] = await h.prepare(["system_launch"]);
    const failure = failureResult({
      errorCode: "system_host_unavailable",
      message: "Captured connection changed.",
    });
    h.executeHostOperation
      .mockResolvedValueOnce(failure)
      .mockRejectedValueOnce(new Error("Transport closed."));
    expect(await module!.implementation({ target: "windows" })).toBe(failure);
    expect(await module!.implementation({ target: "windows" })).toMatchObject({
      ok: false,
      errorCode: "system_execution_route_failed",
    });
    expect(h.executeHostOperation).toHaveBeenCalledTimes(2);
    expect(h.readHostStatus).toHaveBeenCalledOnce();
    expect(h.native).not.toHaveBeenCalled();
  });

  test("the binding remains immutable across status changes; the next request captures the replacement", async () => {
    const h = systemRequestPluginFixture();
    const [first] = await h.prepare(["system_command"]);
    const replacement = "550e8400-e29b-41d4-a716-446655440002";
    h.readHostStatus.mockResolvedValue({
      ...connectedSystemHost,
      connected: true,
      connectionId: replacement,
    });
    const call = { tool: "system_command", params: { target: "windows" } };
    const firstBinding = first!.adapter!.executionBinding!(call).identity;
    const [second] = await h.prepare(["system_command"]);
    expect(firstBinding).toContain(requestConnectionId);
    expect(second!.adapter!.executionBinding!(call).identity).toContain(
      replacement,
    );
    expect(first!.adapter!.executionBinding!(call).identity).toBe(firstBinding);
    await first!.implementation(call.params);
    expect(h.executeHostOperation.mock.calls[0]![1].connectionId).toBe(
      requestConnectionId,
    );
  });

  test("native execution consumes the captured shell without a fresh transport probe", async () => {
    const run = vi.fn<SystemProcessRunner>(async () => ({
      exitCode: 0,
      stdout: "settled",
      stderr: "",
      status: "completed" as const,
      outputTruncated: false,
    }));
    const resolve = vi.fn(async () => ({
      id: "windows" as const,
      transport: "wsl_interop" as const,
      shell: "/captured/fixture-powershell.exe",
    }));
    const handlers = createSystemHandlers(run, resolve);
    expect(
      await handlers.system_command!({
        target: "windows",
        cwd: "C:\\",
        command: "Get-Location",
      }),
    ).toMatchObject({ ok: true });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("windows");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({
      executable: "/captured/fixture-powershell.exe",
    });
  });
});
