import { describe, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";

function tool(name: string, pluginName?: string): ToolModuleDeclaration {
  return {
    definition: {
      name,
      ...(pluginName ? { pluginName } : {}),
      routingCapability: "semantic_lookup",
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: `observe_${name}`,
          summary: "Observe an exact fixture.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      ],
    },
    implementation: vi.fn(async () => ({
      ok: true,
      output: name,
      producedNewInformation: true,
    })),
  };
}

describe("model plugin restrictions on the shared request registry", () => {
  test.each(["private-plugin", "read_private", "private-plugin.read_private"])(
    "uses existing selector semantics for %s across discovery and execution",
    async (selector) => {
      const blocked = tool("read_private", "private-plugin");
      const allowed = tool("read_public", "public-plugin");
      const source = createConfiguredToolRegistry(undefined, [
        blocked,
        allowed,
      ]);
      const registry = restrictToolRegistryToRequestMode(source, "full_plus", {
        deny: [selector],
      });

      expect(registry.listDefinitions().map(({ name }) => name)).toEqual([
        "read_public",
      ]);
      expect(
        registry.listNormalInvocations?.().map(({ toolName }) => toolName),
      ).toEqual(["read_public"]);
      expect(registry.getDefinition("read_private")).toBeUndefined();
      expect(registry.getImplementations().read_private).toBeUndefined();
      expect(registry.hasToolsAvailable()).toBe(true);
      expect(
        await registry.execute({ tool: "read_private", params: {} }),
      ).toMatchObject({
        ok: false,
        errorCode: "tool_model_policy_denied",
      });
      expect(blocked.implementation).not.toHaveBeenCalled();
      expect(
        await registry.execute({ tool: "read_public", params: {} }),
      ).toMatchObject({
        ok: true,
        output: "read_public",
      });
      expect(source.listDefinitions()).toHaveLength(2);
    },
  );

  test("wildcard removes all tools including host tools without plugin provenance", async () => {
    const declared = tool("host_tool");
    const registry = restrictToolRegistryToRequestMode(
      createConfiguredToolRegistry(undefined, [declared]),
      "full_plus",
      { deny: ["*"] },
    );
    expect(registry.listDefinitions()).toEqual([]);
    expect(registry.listNormalInvocations?.()).toEqual([]);
    expect(registry.hasToolsAvailable()).toBe(false);
    expect(
      await registry.execute({ tool: "host_tool", params: {} }),
    ).toMatchObject({
      errorCode: "tool_model_policy_denied",
    });
    expect(declared.implementation).not.toHaveBeenCalled();
  });

  test.each([undefined, { deny: [] }])(
    "omitted or empty restriction preserves the existing catalog",
    async (modelPlugins) => {
      const declared = tool("read_private", "private-plugin");
      const source = createConfiguredToolRegistry(undefined, [declared]);
      const registry = restrictToolRegistryToRequestMode(
        source,
        "full_plus",
        modelPlugins,
      );
      expect(registry.listDefinitions()).toEqual(source.listDefinitions());
      expect(registry.listNormalInvocations?.()).toEqual(
        source.listNormalInvocations?.(),
      );
      expect(
        (await registry.execute({ tool: "read_private", params: {} })).ok,
      ).toBe(true);
    },
  );

  test("captures one model restriction without changing another request or the source registry", async () => {
    const declared = tool("read_private", "private-plugin");
    const source = createConfiguredToolRegistry(undefined, [declared]);
    const mutableRules = { deny: [" private-plugin ", "private-plugin"] };
    const blocked = restrictToolRegistryToRequestMode(
      source,
      "full_plus",
      mutableRules,
    );
    const allowed = restrictToolRegistryToRequestMode(source, "full_plus");
    mutableRules.deny.length = 0;
    const results = await Promise.all([
      blocked.execute({ tool: "read_private", params: {} }),
      allowed.execute({ tool: "read_private", params: {} }),
    ]);
    expect(results.map(({ ok }) => ok)).toEqual([false, true]);
    expect(results[0]?.errorCode).toBe("tool_model_policy_denied");
    expect(declared.implementation).toHaveBeenCalledTimes(1);
    expect(source.listDefinitions()).toHaveLength(1);
  });

  test("model restrictions cannot grant a missing request permission mode", async () => {
    const declared = tool("restricted_mode", "private-plugin");
    declared.definition.requiredPermissionMode = "full_plus";
    const registry = restrictToolRegistryToRequestMode(
      createConfiguredToolRegistry(undefined, [declared]),
      "full_access",
      { deny: [] },
    );
    expect(registry.listDefinitions()).toEqual([]);
    expect(
      await registry.execute({ tool: "restricted_mode", params: {} }),
    ).toMatchObject({
      errorCode: "tool_permission_mode_required",
    });
    expect(declared.implementation).not.toHaveBeenCalled();
  });

  test("enforces model restrictions on a registry with only normal invocation metadata", async () => {
    const declared = tool("read_private", "private-plugin");
    const source = createConfiguredToolRegistry(undefined, [declared]);
    const registry = restrictToolRegistryToRequestMode(
      {
        ...source,
        listDefinitions: () => [],
        getDefinition: () => undefined,
      },
      "full_plus",
      { deny: ["private-plugin"] },
    );
    expect(registry.listNormalInvocations?.()).toEqual([]);
    expect(
      await registry.execute({ tool: "read_private", params: {} }),
    ).toMatchObject({
      errorCode: "tool_model_policy_denied",
    });
    expect(declared.implementation).not.toHaveBeenCalled();
  });

  test.each(["definition", "registration"])(
    "preserves denied provenance when the %s projection has lost it",
    async (stripped) => {
      const declared = tool("read_private", "private-plugin");
      const source = createConfiguredToolRegistry(undefined, [declared]);
      const inconsistent = {
        ...source,
        listDefinitions: () =>
          source.listDefinitions().map((definition) => ({
            ...definition,
            ...(stripped === "definition" ? { pluginName: undefined } : {}),
          })),
        listNormalInvocations: () =>
          source.listNormalInvocations!().map((registration) => ({
            ...registration,
            definition: {
              ...registration.definition,
              ...(stripped === "registration" ? { pluginName: undefined } : {}),
            },
          })),
      };
      const registry = restrictToolRegistryToRequestMode(
        inconsistent,
        "full_plus",
        {
          deny: ["private-plugin"],
        },
      );
      expect(registry.listDefinitions()).toEqual([]);
      expect(registry.listNormalInvocations?.()).toEqual([]);
      expect(
        await registry.execute({ tool: "read_private", params: {} }),
      ).toMatchObject({
        errorCode: "tool_model_policy_denied",
      });
      expect(declared.implementation).not.toHaveBeenCalled();
    },
  );
});
