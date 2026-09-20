import { describe, expect, test, vi } from "vitest";
import { resolveToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { bindRequestToolRegistry } from "../capabilities/request-bound-tool-registry.js";
import { requestNormalInvocationApproval } from "../adapters/registered-tool-normal-invocations/execution/approval.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";

function declaration(name: string, fullPlus = false): ToolModuleDeclaration {
  return {
    definition: {
      name,
      routingCapability: "semantic_lookup",
      ...(fullPlus ? { requiredPermissionMode: "full_plus" as const } : {}),
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: name,
          summary: "Observe one target.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
          effect: "read_only",
          approval: "always",
        },
      ],
    },
    implementation: vi.fn(async (_params, context) => ({
      ok: true,
      output: JSON.stringify(context?.sharedState?.requestContext),
      producedNewInformation: true,
    })),
  };
}

describe("FULL+ request authority", () => {
  test("does not cache a failed registration read as absent permission metadata", async () => {
    const restricted = declaration("restricted", true);
    const source = createConfiguredToolRegistry(undefined, [restricted]);
    const listNormalInvocations = vi
      .fn(source.listNormalInvocations!)
      .mockImplementationOnce(() => {
        throw new Error("catalog read failed");
      });
    const registry = restrictToolRegistryToRequestMode(
      {
        ...source,
        listDefinitions: () =>
          source.listDefinitions().map((definition) => ({
            ...definition,
            requiredPermissionMode: undefined,
          })),
        getImplementations: () => ({}),
        listNormalInvocations,
      },
      "full_access",
    );
    expect(() => registry.listNormalInvocations?.()).toThrow(
      "catalog read failed",
    );
    const result = await registry.execute({ tool: "restricted", params: {} });
    expect(result.errorCode).toBe("tool_permission_mode_required");
    expect(registry.listDefinitions()).toEqual([]);
    expect(listNormalInvocations).toHaveBeenCalledTimes(2);
    expect(restricted.implementation).not.toHaveBeenCalled();
  });
  test("preserves normal-only registry execution while enforcing its own permission metadata", async () => {
    const ordinary = declaration("ordinary");
    const restricted = declaration("restricted", true);
    const source = createConfiguredToolRegistry(undefined, [
      ordinary,
      restricted,
    ]);
    const listNormalInvocations = vi.fn(source.listNormalInvocations!);
    const thin = {
      ...source,
      listDefinitions: () => [],
      getDefinition: () => undefined,
      listNormalInvocations,
    };
    const full = restrictToolRegistryToRequestMode(thin, "full_access");
    expect(
      full.listNormalInvocations?.().map(({ toolName }) => toolName),
    ).toEqual(["ordinary"]);
    expect((await full.execute({ tool: "ordinary", params: {} })).ok).toBe(
      true,
    );
    expect(
      (await full.execute({ tool: "restricted", params: {} })).errorCode,
    ).toBe("tool_permission_mode_required");
    expect(listNormalInvocations).toHaveBeenCalledTimes(1);
    expect(restricted.implementation).not.toHaveBeenCalled();
  });
  test("a restriction on either canonical projection cannot be stripped by the other", async () => {
    const restricted = declaration("restricted", true);
    const source = createConfiguredToolRegistry(undefined, [restricted]);
    const inconsistent = {
      ...source,
      listNormalInvocations: () =>
        source.listNormalInvocations!().map((registration) => ({
          ...registration,
          definition: {
            ...registration.definition,
            requiredPermissionMode: undefined,
          },
        })),
    };
    const full = restrictToolRegistryToRequestMode(inconsistent, "full_access");
    expect(full.listNormalInvocations?.()).toEqual([]);
    expect(full.listDefinitions()).toEqual([]);
    expect((await full.execute({ tool: "restricted", params: {} })).ok).toBe(
      false,
    );
    expect(restricted.implementation).not.toHaveBeenCalled();
  });

  test.each([undefined, null, "unknown", "FULL_PLUS", " full_plus "])(
    "does not promote unknown or noncanonical mode %s",
    (value) => {
      expect(resolveToolPermissionMode(value)).toBe("ask");
    },
  );
  test("preserves existing mode aliases and requires exact new selection", () => {
    expect(resolveToolPermissionMode("FULL")).toBe("full_access");
    expect(resolveToolPermissionMode("full_access")).toBe("full_access");
    expect(resolveToolPermissionMode("full_plus")).toBe("full_plus");
  });
  test.each(["ask", "full_access"] as const)(
    "filters every catalog and denies direct execution in %s",
    async (mode) => {
      const ordinary = declaration("ordinary");
      const system = declaration("system", true);
      const registry = restrictToolRegistryToRequestMode(
        createConfiguredToolRegistry(undefined, [ordinary, system]),
        mode,
      );
      expect(registry.listDefinitions().map(({ name }) => name)).toEqual([
        "ordinary",
      ]);
      expect(
        registry.listNormalInvocations?.().map(({ toolName }) => toolName),
      ).toEqual(["ordinary"]);
      expect(registry.getDefinition("system")).toBeUndefined();
      expect(registry.getImplementations().system).toBeUndefined();
      const result = await registry.execute(
        { tool: "system", params: {} },
        {
          sharedState: {
            requestContext: {
              agentMode: "fast",
              toolPermissionMode: "full_plus",
            },
          },
        },
      );
      expect(result.errorCode).toBe("tool_permission_mode_required");
      expect(system.implementation).not.toHaveBeenCalled();
      expect(
        (await registry.execute({ tool: "ordinary", params: {} })).ok,
      ).toBe(true);
    },
  );
  test("binds FULL+ authority independently of caller shared state and exposes exact filtered passive catalog", async () => {
    const source = createConfiguredToolRegistry(undefined, [
      declaration("ordinary"),
      declaration("system", true),
    ]);
    const registry = restrictToolRegistryToRequestMode(source, "full_plus");
    const result = await registry.execute(
      { tool: "system", params: {} },
      {
        sharedState: {
          requestContext: { agentMode: "reasoning", toolPermissionMode: "ask" },
        },
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      toolPermissionMode: "full_plus",
      agentMode: "reasoning",
    });
    const ask = bindRequestToolRegistry({
      registry: restrictToolRegistryToRequestMode(source, "ask"),
      modelInvoker: { invokeText: vi.fn() },
    });
    expect(
      ask
        .prepareSharedState?.()
        .availableTools?.map(({ toolName }) => toolName),
    ).toEqual(["ordinary"]);
  });
  test.each(["ask", "full_access", "full_plus"] as const)(
    "keeps forced approval semantics appropriate to %s",
    async (mode) => {
      const requestToolApproval = vi.fn(async () => ({ approved: true }));
      const onEvent = vi.fn();
      await requestNormalInvocationApproval({
        requestId: "test",
        abortSignal: new AbortController().signal,
        toolPermissionMode: mode,
        force: true,
        call: { tool: "sample", params: {} },
        toolApprovalController: { requestToolApproval },
        nextApprovalId: () => "approval",
        onEvent,
      });
      expect(requestToolApproval).toHaveBeenCalledTimes(
        mode === "full_plus" ? 0 : 1,
      );
      if (mode === "full_plus") expect(onEvent).not.toHaveBeenCalled();
    },
  );
  test("rejects an ordinary adapter normalization into a restricted target before execution", async () => {
    const ordinary = declaration("ordinary");
    ordinary.adapter = {
      normalizeCall: () => ({ tool: "system", params: {} }),
    };
    const system = declaration("system", true);
    const registry = createConfiguredToolRegistry(undefined, [
      ordinary,
      system,
    ]);
    const executor = createRegisteredToolNormalInvocationExecutor({
      registrations: registry.listNormalInvocations!(),
      toolRegistry: registry,
      requestId: "direct",
      abortSignal: new AbortController().signal,
      sharedState: {},
      toolPermissionMode: "full_access",
      nextApprovalId: () => "never",
    });
    const result = executor.prepare({
      handle: executor.operations.find(
        ({ operation }) => operation.operationId === "ordinary",
      )!.handle,
      controls: {},
    });
    expect(result.status).toBe("rejected");
    expect(system.implementation).not.toHaveBeenCalled();
  });
});
