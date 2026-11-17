import { describe, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { bindRequestToolRegistry } from "../capabilities/request-bound-tool-registry.js";
import { loadConfiguredRuntimePlugins, runtimePluginsToToolModules } from "../plugins/loader.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";
import { prepareRequestToolModules } from "../capabilities/request-module-preparation.js";

const EA = "execution-agent-v1";
const SUPER = "supervisor-worker-v1";
function tool(name: string, executionPolicies?: readonly RequestExecutionPolicyId[], fullPlus = false): ToolModuleDeclaration {
  return {
    definition: {
      name, pluginName: `plugin-${name}`, routingCapability: "semantic_lookup",
      ...(executionPolicies ? { executionPolicies } : {}),
      ...(fullPlus ? { requiredPermissionMode: "full_plus" as const } : {}),
    },
    normalInvocation: {
      version: 1,
      operations: [{
        operationId: name, summary: "Observe a fixture target.",
        input: { type: "object", properties: {}, required: [], additionalProperties: false },
        effect: "read_only", approval: "request_policy",
      }],
    },
    adapter: { normalizeCall: (input) => input },
    implementation: vi.fn(async () => ({ ok: true, output: name, producedNewInformation: true })),
  };
}
function declarations() {
  return [tool("alpha", [SUPER]), tool("beta", [EA]), tool("gamma"), tool("delta", [EA, SUPER])];
}
function prepared(policy: string, modules = declarations(), deny: string[] = []) {
  return restrictToolRegistryToRequestMode(createConfiguredToolRegistry(undefined, modules),
    "full_access", { deny }, policy);
}

describe("declarative plugin execution policies", () => {
  test("skips incompatible plugin preparation before capturing request resources", async () => {
    const prepare = vi.fn(async (modules: readonly ToolModuleDeclaration[]) => modules);
    const source = [
      { ...tool("alpha", [EA]), prepareRequest: prepare },
      tool("beta", [SUPER]), tool("gamma"),
    ];
    const selected = await prepareRequestToolModules(source, { executionPolicy: SUPER });
    expect(selected.map(({ definition }) => definition.name)).toEqual(["beta", "gamma"]);
    expect(prepare).not.toHaveBeenCalled();
    const ea = await prepareRequestToolModules(source, { executionPolicy: EA });
    expect(ea.map(({ definition }) => definition.name)).toEqual(["alpha", "gamma"]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0].map(({ definition }) => definition.name)).toEqual(["alpha"]);
  });

  test("bundled system is available only to EA, including direct execution rejection for SUPER", async () => {
    const config = loadPublicRuntimeConfig(["system"]);
    const modules = runtimePluginsToToolModules(loadConfiguredRuntimePlugins(config));
    const source = createConfiguredToolRegistry(config, modules);
    const ea = restrictToolRegistryToRequestMode(source, "full_plus", undefined, EA);
    const superRegistry = restrictToolRegistryToRequestMode(source, "full_plus", undefined, SUPER);
    expect(ea.listDefinitions().length).toBeGreaterThan(0);
    expect(superRegistry.listDefinitions()).toEqual([]);
    expect(superRegistry.listNormalInvocations!()).toEqual([]);
    expect(superRegistry.getImplementations()).toEqual({});
    for (const { name } of source.listDefinitions()) {
      expect(await superRegistry.execute({ tool: name, params: {} }))
        .toMatchObject({ ok: false, errorCode: "tool_execution_policy_denied" });
    }
  });

  test.each([
    [EA, "alpha", ["beta", "gamma", "delta"]],
    [SUPER, "beta", ["alpha", "gamma", "delta"]],
  ] as const)("%s uses the same route gate for discovery, adapters and execution", async (policy, blocked, expected) => {
    const modules = declarations();
    const source = createConfiguredToolRegistry(undefined, modules);
    const registry = restrictToolRegistryToRequestMode(source, "full_access", undefined, policy);
    expect(registry.listDefinitions().map(({ name }) => name)).toEqual(expected);
    expect(registry.listNormalInvocations!().map(({ toolName }) => toolName)).toEqual(expected);
    expect(Object.keys(registry.getImplementations())).toEqual(expected);
    expect(registry.getDefinition(blocked)).toBeUndefined();
    expect(registry.getAdapter!(blocked)).toBeUndefined();
    expect(await registry.execute({ tool: blocked, params: {} }))
      .toMatchObject({ ok: false, errorCode: "tool_execution_policy_denied" });
    expect(modules.find(({ definition }) => definition.name === blocked)!.implementation).not.toHaveBeenCalled();
    for (const name of expected) {
      expect(registry.getDefinition(name)).toBe(source.getDefinition(name));
      expect(registry.getAdapter!(name)).toBe(source.getAdapter!(name));
      expect((await registry.execute({ tool: name, params: {} })).ok).toBe(true);
    }
    expect(source.listDefinitions()).toHaveLength(4);
  });

  test.each(["plugin-beta", "beta", "plugin-beta.beta", "*"])("retains independent model deny %s", async (selector) => {
    const registry = prepared(EA, declarations(), [selector]);
    expect(registry.getDefinition("beta")).toBeUndefined();
    expect(await registry.execute({ tool: "beta", params: {} }))
      .toMatchObject({ ok: false, errorCode: "tool_model_policy_denied" });
  });

  test("no dependency or fallback between differently scoped plugins", async () => {
    expect(prepared(EA, [tool("alpha", [SUPER])]).hasToolsAvailable()).toBe(false);
    const registry = prepared(EA, [tool("beta", [EA])]);
    expect(registry.listDefinitions().map(({ name }) => name)).toEqual(["beta"]);
    expect((await registry.execute({ tool: "beta", params: {} })).ok).toBe(true);
  });

  test("route compatibility does not grant higher permission", async () => {
    const registry = prepared(EA, [tool("beta", [EA], true)]);
    expect(registry.hasToolsAvailable()).toBe(false);
    expect(await registry.execute({ tool: "beta", params: {} }))
      .toMatchObject({ ok: false, errorCode: "tool_permission_mode_required" });
  });

  test("names confer no policy: same-named third party tools remain available", async () => {
    const registry = prepared(EA, [tool("read_file"), tool("edit_file"), tool("system_probe")]);
    expect(registry.listDefinitions().map(({ name }) => name)).toEqual(["read_file", "edit_file", "system_probe"]);
    expect((await registry.execute({ tool: "edit_file", params: {} })).ok).toBe(true);
  });

  test("normal-only registries cannot bypass route restrictions", async () => {
    const source = createConfiguredToolRegistry(undefined, declarations());
    const registry = restrictToolRegistryToRequestMode({
      ...source, listDefinitions: () => [], getDefinition: () => undefined,
    }, "full_access", undefined, EA);
    expect(registry.hasToolsAvailable()).toBe(true);
    expect(registry.listNormalInvocations!().map(({ toolName }) => toolName)).toEqual(["beta", "gamma", "delta"]);
    expect(await registry.execute({ tool: "alpha", params: {} }))
      .toMatchObject({ errorCode: "tool_execution_policy_denied" });
  });

  test("a declared route restriction wins over inconsistent registration metadata", async () => {
    const source = createConfiguredToolRegistry(undefined, [tool("alpha", [SUPER])]);
    const normal = createConfiguredToolRegistry(undefined, [tool("alpha")]);
    const registry = restrictToolRegistryToRequestMode({
      ...source, listNormalInvocations: normal.listNormalInvocations,
    }, "full_access", undefined, EA);
    expect(registry.hasToolsAvailable()).toBe(false);
    expect(registry.listNormalInvocations!()).toEqual([]);
    expect(await registry.execute({ tool: "alpha", params: {} }))
      .toMatchObject({ errorCode: "tool_execution_policy_denied" });
  });

  test("request binding publishes only the selected catalog to tool context", () => {
    const registry = bindRequestToolRegistry({
      registry: prepared(EA), modelInvoker: { invokeText: async () => "unused" },
    });
    expect(registry.prepareSharedState!().availableTools!.map(({ toolName }) => toolName).sort())
      .toEqual(["beta", "delta", "gamma"]);
  });

  test("independent captures keep their selected route and source unchanged", () => {
    const source = createConfiguredToolRegistry(undefined, declarations());
    const ea = restrictToolRegistryToRequestMode(source, "full_access", undefined, EA);
    const superRegistry = restrictToolRegistryToRequestMode(source, "full_access", undefined, SUPER);
    expect(ea.getDefinition("beta")).toBeDefined();
    expect(superRegistry.getDefinition("beta")).toBeUndefined();
    expect(source.listDefinitions()).toHaveLength(4);
    // Consumers without an EA/SUPER request (e.g. deterministic automation steps)
    // retain their existing grants and do not invent a model execution route.
    expect(restrictToolRegistryToRequestMode(source, "full_access").listDefinitions()).toHaveLength(4);
  });
});
