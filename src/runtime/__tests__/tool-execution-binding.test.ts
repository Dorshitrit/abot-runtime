import { describe, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import type { ToolApprovalController, ToolPermissionMode } from "../ports.js";

function harness(
  identity: string | null,
  mode: ToolPermissionMode = "ask",
  approval?: ToolApprovalController,
) {
  const implementation = vi.fn(async () => ({
    ok: true,
    output: "finished",
    producedNewInformation: true,
  }));
  const binding = vi.fn(() => ({
    identity: identity!,
    metadata: { computerName: "Test computer", displayTarget: "test" },
  }));
  const module: ToolModuleDeclaration = {
    definition: { name: "bound_action", routingCapability: "semantic_lookup" },
    implementation,
    adapter: { executionBinding: binding },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "bound_action",
          summary: "Perform the requested action.",
          effect: "mixed",
          approval: "always",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      ],
    },
  };
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const onEvent = vi.fn();
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(),
    toolRegistry: registry,
    requestId: "binding-test",
    abortSignal: new AbortController().signal,
    toolPermissionMode: mode,
    nextApprovalId: () => "one",
    onEvent,
    ...(approval ? { toolApprovalController: approval } : {}),
  });
  const prepared = executor.prepare({
    handle: executor.operations[0]!.handle,
    controls: {},
  });
  return { prepared, implementation, binding, onEvent, registry };
}

describe("private execution authority", () => {
  test("binds destination before action identity and never exposes the identifier as controls", () => {
    const first = harness("opaque-A");
    const equivalent = harness("opaque-A");
    const second = harness("opaque-B");
    expect(first.prepared.status).toBe("prepared");
    if (
      first.prepared.status !== "prepared" ||
      equivalent.prepared.status !== "prepared" ||
      second.prepared.status !== "prepared"
    )
      throw new Error("missing preparation");
    expect(first.prepared.actionFingerprint).toBe(
      equivalent.prepared.actionFingerprint,
    );
    expect(first.prepared.actionFingerprint).not.toBe(
      second.prepared.actionFingerprint,
    );
    expect(first.prepared.acceptedControls).toEqual({});
    expect(JSON.stringify(first.registry.listDefinitions())).not.toContain(
      "opaque-A",
    );
    expect(first.binding).toHaveBeenCalledOnce();
    expect(first.implementation).not.toHaveBeenCalled();
  });

  test.each(["ask", "full_access"] as const)(
    "%s displays captured destination before dispatch",
    async (mode) => {
      let approve!: () => void;
      const requestToolApproval = vi.fn<
        ToolApprovalController["requestToolApproval"]
      >(
        () =>
          new Promise<{ approved: true }>((resolve) => {
            approve = () => resolve({ approved: true });
          }),
      );
      const h = harness("opaque-A", mode, { requestToolApproval });
      if (h.prepared.status !== "prepared")
        throw new Error("missing preparation");
      const pending = h.prepared.execute();
      expect(h.implementation).not.toHaveBeenCalled();
      expect(requestToolApproval.mock.calls[0]![0]).toMatchObject({
        call: { tool: "bound_action", params: {} },
        meta: { computerName: "Test computer" },
      });
      expect(JSON.stringify(requestToolApproval.mock.calls)).not.toContain(
        "opaque-A",
      );
      approve();
      expect(await pending).toMatchObject({
        status: "executed",
        result: { ok: true },
      });
      expect(h.binding).toHaveBeenCalledOnce();
      expect(h.implementation).toHaveBeenCalledOnce();
      expect(
        h.onEvent.mock.calls.find(([name]) => name === "tool.completed")![1],
      ).toMatchObject({ meta: { computerName: "Test computer" } });
      expect(JSON.stringify(await pending)).not.toContain("computerName");
    },
  );

  test("FULL+ skips approval but still captures binding", async () => {
    const requestToolApproval = vi.fn();
    const h = harness("opaque-A", "full_plus", { requestToolApproval });
    if (h.prepared.status !== "prepared")
      throw new Error("missing preparation");
    await h.prepared.execute();
    expect(h.binding).toHaveBeenCalledOnce();
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(h.implementation).toHaveBeenCalledOnce();
  });

  test("missing execution identity fails closed without approval or effects", () => {
    const h = harness(null);
    expect(h.prepared).toMatchObject({
      status: "rejected",
      code: "normal_invocation_execution_binding_unavailable",
    });
    expect(h.implementation).not.toHaveBeenCalled();
  });
});
