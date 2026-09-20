import { describe, expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../../plugins/system/source/handlers.js";
import type { SystemProcessRunner } from "../../../plugins/system/source/contracts.js";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import {
  loadConfiguredRuntimePlugins,
  runtimePluginsToToolModules,
} from "../plugins/loader.js";
import type {
  ToolApprovalController,
  ToolApprovalDecision,
  ToolPermissionMode,
} from "../ports.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const command = {
  target: "linux",
  cwd: "/tmp",
  command: "printf 'fixture only'",
};
function harness(
  mode: ToolPermissionMode,
  approval?: ToolApprovalController,
  normalized = false,
) {
  const config = loadPublicRuntimeConfig(["system"]);
  const run = vi.fn<SystemProcessRunner>(async () => ({
    exitCode: 0,
    stdout: "fixture only",
    stderr: "",
    status: "completed",
    outputTruncated: false,
  }));
  const handlers = createSystemHandlers(run);
  const implementation = vi.fn(handlers.system_command!);
  const modules: ToolModuleDeclaration[] = runtimePluginsToToolModules(
    loadConfiguredRuntimePlugins(config),
  ).map((entry) => ({
    ...entry,
    implementation:
      entry.definition.name === "system_command"
        ? implementation
        : handlers[entry.definition.name]!,
  }));
  if (normalized)
    modules.push({
      definition: {
        name: "normalized_source",
        routingCapability: "semantic_lookup",
      },
      normalInvocation: {
        version: 1,
        operations: [
          {
            operationId: "normalized_source",
            summary: "Select an equivalent native action.",
            effect: "mixed",
            approval: "request_policy",
            input: {
              type: "object",
              additionalProperties: false,
              properties: {},
              required: [],
            },
          },
        ],
      },
      adapter: {
        normalizeCall: () => ({
          tool: "system_command",
          params: { ...command },
        }),
      },
      implementation: vi.fn(),
    } as ToolModuleDeclaration);
  const registry = restrictToolRegistryToRequestMode(
    createConfiguredToolRegistry(config, modules),
    mode,
  );
  const controller = new AbortController();
  const onEvent = vi.fn();
  let sequence = 0;
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(),
    toolRegistry: registry,
    requestId: "approval-test",
    abortSignal: controller.signal,
    toolPermissionMode: mode,
    toolApprovalController: approval,
    nextApprovalId: () => "approval-" + ++sequence,
    onEvent,
  });
  const handle = executor.operations.find(
    ({ operation }) =>
      operation.operationId ===
      (normalized ? "normalized_source" : "run_system_command"),
  )!.handle;
  return {
    registry,
    run,
    implementation,
    onEvent,
    controller,
    execute: () =>
      executor.execute({
        handle,
        controls: normalized ? {} : { ...command },
        intent: "Inspect the requested target.",
      }),
  };
}

describe("system actions use existing per-invocation approval", () => {
  test.each(["ask", "full_access"] as const)(
    "%s waits before native dispatch and approval leaves mode unchanged",
    async (mode) => {
      let decide!: (decision: ToolApprovalDecision) => void;
      const requestToolApproval = vi.fn<
        ToolApprovalController["requestToolApproval"]
      >(
        () =>
          new Promise((resolve) => {
            decide = resolve;
          }),
      );
      const h = harness(mode, { requestToolApproval });
      expect(h.registry.getDefinition("system_command")).toBeDefined();
      const pending = h.execute();
      expect(requestToolApproval).toHaveBeenCalledOnce();
      expect(h.run).not.toHaveBeenCalled();
      expect(requestToolApproval.mock.calls[0]![0].call).toEqual({
        tool: "system_command",
        params: command,
      });
      const required = h.onEvent.mock.calls.find(
        ([name]) => name === "tool.approval.required",
      )![1];
      expect(required).toMatchObject({
        meta: { command: command.command, displayTarget: "linux", cwd: "/tmp" },
      });
      expect(required.recommendedToolPermissionMode).toBe(
        mode === "full_access" ? "full_plus" : undefined,
      );
      decide({ approved: true });
      expect(await pending).toMatchObject({
        status: "executed",
        result: { ok: true },
      });
      expect(h.run).toHaveBeenCalledOnce();
      expect(
        h.implementation.mock.calls[0]![1]?.sharedState?.requestContext
          ?.toolPermissionMode,
      ).toBe(mode);
      const second = h.execute();
      expect(requestToolApproval).toHaveBeenCalledTimes(2);
      expect(h.run).toHaveBeenCalledOnce();
      decide({ approved: false });
      expect(await second).toMatchObject({
        status: "rejected",
        code: "tool_approval_rejected",
      });
      expect(h.run).toHaveBeenCalledOnce();
    },
  );

  test.each(["ask", "full_access"] as const)(
    "%s rejection or missing controller never reaches execution",
    async (mode) => {
      const denied = harness(mode, {
        requestToolApproval: async () => ({
          approved: false,
          reason: "owner rejected",
        }),
      });
      expect(await denied.execute()).toMatchObject({
        status: "rejected",
        code: "tool_approval_rejected",
      });
      expect(denied.run).not.toHaveBeenCalled();
      const missing = harness(mode);
      expect(await missing.execute()).toMatchObject({
        status: "rejected",
        code: "tool_approval_unavailable",
      });
      expect(missing.run).not.toHaveBeenCalled();
    },
  );

  test("FULL+ dispatches without invoking an approval controller", async () => {
    const requestToolApproval =
      vi.fn<ToolApprovalController["requestToolApproval"]>();
    const h = harness("full_plus", { requestToolApproval });
    expect(await h.execute()).toMatchObject({
      status: "executed",
      result: { ok: true },
    });
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(h.run).toHaveBeenCalledOnce();
    expect(
      h.onEvent.mock.calls.some(([name]) => name.startsWith("tool.approval.")),
    ).toBe(false);
  });

  test("normalization into a forced target asks about that exact normalized action", async () => {
    const requestToolApproval = vi.fn(async () => ({ approved: true }));
    const h = harness("full_access", { requestToolApproval }, true);
    expect(await h.execute()).toMatchObject({
      status: "executed",
      result: { ok: true },
    });
    expect(requestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        call: { tool: "system_command", params: command },
      }),
      expect.anything(),
    );
    expect(h.run).toHaveBeenCalledOnce();
  });

  test("abort after approval was requested prevents dispatch even if the controller grants", async () => {
    let decide!: (decision: ToolApprovalDecision) => void;
    const h = harness("full_access", {
      requestToolApproval: () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    });
    const pending = h.execute();
    h.controller.abort();
    decide({ approved: true });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(h.run).not.toHaveBeenCalled();
  });
});
