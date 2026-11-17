import { expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { ToolDiscoveryDeclaration } from "../../capabilities/tool-request-discovery.js";
import { parseToolDefinition } from "../../capabilities/tool-definition-validator.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { validateManifestEntrypoint } from "../plugins/entrypoint-validation.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { bindRequestToolRegistry } from "../capabilities/request-bound-tool-registry.js";
import { scopeToolRegistry } from "../automations/agent-tool-scope.js";
import { communityManifest } from "./support/plugin-installation-fixture.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { fingerprintAutomationDependencies } from "../automations/dependency-fingerprint.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import type { RuntimeConfig } from "../ports.js";

function module(name: string): ToolModuleDeclaration {
  return {
    definition: { name, pluginName: "arbitrary-plugin", routingCapability: "semantic_lookup" },
    implementation: vi.fn(async () => ({ ok: true, output: "executed", producedNewInformation: true })),
    normalInvocation: { version: 1, operations: ["first", "second"].map((operationId) => ({
      operationId, summary: "Observe", effect: "read_only", approval: "request_policy",
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    })) },
  };
}

function requestBound(name = "bound") {
  const declaration = module(name);
  declaration.definition.requiresRequestBinding = true;
  declaration.definition.executionPolicies = ["execution-agent-v1"];
  declaration.discoverCapabilities = vi.fn<NonNullable<ToolModuleDeclaration["discoverCapabilities"]>>(
    async (selected: readonly ToolDiscoveryDeclaration[]) => selected.map(({ definition }) => definition.name));
  declaration.prepareRequest = vi.fn<NonNullable<ToolModuleDeclaration["prepareRequest"]>>(
    async (selected, context) => context?.requestId ? selected : []);
  return declaration;
}

test.each([false, null, "true", 1])("rejects invalid request-binding declarations: %j", (requiresRequestBinding) => {
  const raw = communityManifest();
  Object.assign(raw.extensions["ai.abot.runtime"], { requiresRequestBinding });
  expect(() => parseAgentPluginManifest(raw, raw.name)).toThrow("requiresRequestBinding");
  expect(() => parseToolDefinition({ ...module("probe").definition, params: {}, requiresRequestBinding }))
    .toThrow("requiresRequestBinding");
});

test("requires explicit discovery and preparation hooks only for declared request-bound plugins", () => {
  const handlers = { probe: module("probe").implementation };
  const input = { pluginId: "arbitrary-plugin", expectedCapabilityIds: ["probe"] };
  expect(validateManifestEntrypoint({ ...input, raw: { handlers } })).toEqual({ handlers });
  expect(() => validateManifestEntrypoint({ ...input, requiresRequestBinding: true, raw: { handlers } }))
    .toThrow("requires prepareRequest and discoverCapabilities");
  expect(() => validateManifestEntrypoint({ ...input, raw: { handlers, discoverCapabilities: async () => [] } }))
    .toThrow("discovery requires requiresRequestBinding");
});

test("discovers selected metadata without binding; preserves dynamic ordinary availability", async () => {
  const bound = requestBound();
  const ordinary = module("ordinary");
  ordinary.prepareRequest = vi.fn(async (selected: readonly ToolModuleDeclaration[]) => selected.map((entry) => ({ ...entry,
    normalInvocation: { ...entry.normalInvocation, operations: entry.normalInvocation.operations.slice(0, 1) },
  })));
  const unavailable = module("unavailable");
  unavailable.prepareRequest = vi.fn(async () => []);
  const registry = createConfiguredToolRegistry(undefined, [bound, ordinary, unavailable]);
  const discovered = await registry.discoverOperations!();
  expect(discovered.map(({ toolName }) => toolName)).toEqual(["bound", "ordinary"]);
  expect(discovered[1]!.contract.operations).toHaveLength(1);
  expect(bound.prepareRequest).not.toHaveBeenCalled();
  expect(ordinary.prepareRequest).toHaveBeenCalledOnce();
  expect(bound.implementation).not.toHaveBeenCalled();
  const metadata = vi.mocked(bound.discoverCapabilities!).mock.calls[0]![0];
  expect(Object.keys(metadata[0]!)).toEqual(["definition", "normalInvocation"]);
  expect(metadata[0]!.definition).not.toBe(bound.definition);
  expect(discovered[0]).not.toHaveProperty("adapter");
});

test("discovery cannot restore disabled capabilities, widen selection or hide failures", async () => {
  const disabled = requestBound("disabled");
  disabled.discoverCapabilities = async () => [];
  expect(await createConfiguredToolRegistry(undefined, [disabled]).discoverOperations!()).toEqual([]);
  for (const names of [["undeclared"], ["disabled", "disabled"]]) {
    disabled.discoverCapabilities = async () => names;
    await expect(createConfiguredToolRegistry(undefined, [disabled]).discoverOperations!()).rejects.toThrow("unselected or duplicate");
  }
  disabled.discoverCapabilities = async () => { throw new Error("discovery failed"); };
  await expect(createConfiguredToolRegistry(undefined, [disabled]).discoverOperations!()).rejects.toThrow("discovery failed");
});

test("prepared discovery keeps captured availability and operation narrowing without rerunning hooks", async () => {
  const bound = requestBound();
  bound.prepareRequest = vi.fn(async (selected: readonly ToolModuleDeclaration[]) => selected.map((entry) => ({ ...entry,
    normalInvocation: { ...entry.normalInvocation, operations: entry.normalInvocation.operations.slice(1) },
  })));
  const registry = createConfiguredToolRegistry(undefined, [bound]);
  const prepared = await registry.prepareRequest!({ requestId: "captured", executionPolicy: "execution-agent-v1" });
  bound.discoverCapabilities = async () => [];
  expect((await prepared.discoverOperations!())[0]!.contract.operations.map(({ operationId }) => operationId)).toEqual(["second"]);
  expect(bound.prepareRequest).toHaveBeenCalledOnce();
  expect(await registry.prepareRequest!({ executionPolicy: "supervisor-worker-v1" }).then((r) => r.discoverOperations!())).toEqual([]);
});

test("permission, model, route, request-binding and Agent-selection wrappers only narrow discovery", async () => {
  const bound = requestBound();
  const privileged = requestBound("privileged");
  privileged.definition.requiredPermissionMode = "full_plus";
  const registry = createConfiguredToolRegistry(undefined, [bound, privileged]);
  const full = restrictToolRegistryToRequestMode(registry, "full_access");
  expect((await full.discoverOperations!()).map(({ toolName }) => toolName)).toEqual(["bound"]);
  expect(await restrictToolRegistryToRequestMode(registry, "full_plus", { deny: ["arbitrary-plugin"] }).discoverOperations!()).toEqual([]);
  expect(await restrictToolRegistryToRequestMode(registry, "full_plus", undefined, "supervisor-worker-v1").discoverOperations!()).toEqual([]);
  const attached = bindRequestToolRegistry({ registry: full, modelInvoker: { invokeText: vi.fn() } });
  const scoped = scopeToolRegistry(attached, [{ toolName: "bound", operationId: "second", contractVersion: 1 }],
    new WeakMap(), new Map(), () => undefined, (invoke) => invoke());
  const discovered = await scoped.discoverOperations!();
  expect(discovered).toHaveLength(1);
  expect(discovered[0]!.contract.operations.map(({ operationId }) => operationId)).toEqual(["second"]);
});

test("introducing a request-binding requirement invalidates a published dependency contract", () => {
  const draft = createEmptyAutomationDefinition("automation", "Contract");
  const operation = { toolName: "arbitrary", operationId: "observe", contractVersion: 1 };
  const definition = { ...draft, body: { ...draft.body, children: [{
    kind: "tool" as const, id: "step", title: "Observe", onFailure: "stop" as const, operation, controls: {},
  }] } };
  const catalog: AutomationCatalogOperation = { ...operation, label: "Observe", catalogGroups: [],
    permissionMode: "full_access", effect: "read_only", approval: "request_policy",
    input: { type: "object", additionalProperties: false, properties: {}, required: [] } };
  const digest = (entry: AutomationCatalogOperation) => fingerprintAutomationDependencies({
    definition, config: {} as RuntimeConfig, operations: [entry],
  });
  expect(digest({ ...catalog, requiresRequestBinding: true })).not.toBe(digest(catalog));
  expect(digest({ ...catalog, requiresRequestBinding: undefined })).toBe(digest(catalog));
});
