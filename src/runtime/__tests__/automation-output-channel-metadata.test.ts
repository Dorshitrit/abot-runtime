import { describe, expect, it, vi } from "vitest";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { resolveRegisteredToolCapabilityCatalog } from "../adapters/registered-tool-worker-capabilities/catalog.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import { readAutomationAuthoringCatalogIndex, readAutomationAuthoringCatalogOperation } from "../capabilities/automations/authoring-catalog.js";
import { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { discoverAgentPluginManifests } from "../plugins/manifest-discovery.js";
import { projectManifestRuntimeContract } from "../plugins/manifest-projection.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

function webRegistries() {
  const discovered = discoverAgentPluginManifests(process.cwd())
    .find(({ manifest }) => manifest.name === "web")!;
  const source = discovered.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities.web_search!;
  const projected = projectManifestRuntimeContract(discovered, ["web_search"]);
  const execute = vi.fn(async () => { throw new Error("unexpected_workflow_execution"); });
  const modules = projected.capabilities.map((capability) => ({ ...capability, implementation: execute }));
  const legacyModules = modules.map((module) => ({ ...module,
    normalInvocation: { ...module.normalInvocation,
      operations: module.normalInvocation.operations.map(({ outputChannels: _channels, ...operation }) => operation),
    },
  }));
  return { source, execute,
    registry: createConfiguredToolRegistry(undefined, modules),
    legacy: createConfiguredToolRegistry(undefined, legacyModules),
  };
}

describe("automation plugin output-channel metadata", () => {
  it("carries exact real-manifest channels only for selected preparation references without execution or grants", async () => {
    const { registry, source, execute } = webRegistries();
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, registry);
    try {
      const prepared = await readAutomationAuthoringPreparation(fixture.application.services.automations!, {
        operationRefs: ["web_search/search_many@1"],
      });
      expect(prepared.operations).toHaveLength(1);
      expect(prepared.operations[0]).toMatchObject({
        operationId: "search_many", label: source.operations.search_many!.summary,
        outputChannels: { text: "content", data: "metadata" }, granted: false,
      });
      expect(prepared.operations[0]!.outputChannels).toEqual(source.operations.search_many!.outputChannels);
      expect(prepared.authoringReference).toBe(AUTOMATION_AUTHORING_REFERENCE);
      expect(prepared.authoringReference.bindings.examples.earlierWholeData)
        .toEqual({ kind: "node_result", nodeId: "$first", select: "data" });
      expect(prepared).toMatchObject({ grantsPermissions: false, executesWorkflow: false });
      expect(Buffer.byteLength(JSON.stringify(prepared))).toBeLessThanOrEqual(prepared.maxBytes);
      const empty = await readAutomationAuthoringPreparation(fixture.application.services.automations!, { operationRefs: [] });
      expect(empty.operations).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(fixture.invoke).not.toHaveBeenCalled();
      expect(fixture.invokeRaw).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps ordinary model catalogs identical when output metadata is present", () => {
    const { registry, legacy } = webRegistries();
    expect(projectAvailableTools(registry.listNormalInvocations?.()))
      .toEqual(projectAvailableTools(legacy.listNormalInvocations?.()));
    expect(resolveRegisteredToolCapabilityCatalog(registry, true).descriptors)
      .toEqual(resolveRegisteredToolCapabilityCatalog(legacy, true).descriptors);
  });

  it("does not expand discovery or legacy catalog responses with authoring-only channel metadata", async () => {
    const { registry } = webRegistries();
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, registry);
    try {
      const service = fixture.application.services.automations!;
      const draft = await service.create("Catalog projection test");
      const index = await readAutomationAuthoringCatalogIndex(service, draft.automationId, 0);
      for (const operation of index.operations.items) expect(operation).not.toHaveProperty("outputChannels");
      const detail = await readAutomationAuthoringCatalogOperation(service, draft.automationId, "web_search", "search_one", 1);
      expect(detail.operation).not.toHaveProperty("outputChannels");
      const module = createAutomationDraftToolModule(() => service, async () => undefined);
      const result = await module.implementation({ action: "catalog", automationId: draft.automationId });
      expect(result.ok).toBe(true);
      const catalog = JSON.parse(result.output);
      expect(catalog.operations).toHaveLength(2);
      for (const operation of catalog.operations) expect(operation).not.toHaveProperty("outputChannels");
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps undeclared legacy outputs unknown during preparation", async () => {
    const { legacy } = webRegistries();
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, legacy);
    try {
      const prepared = await readAutomationAuthoringPreparation(fixture.application.services.automations!, {
        operationRefs: ["web_search/search_one@1"],
      });
      expect(prepared.operations).toHaveLength(1);
      expect(prepared.operations[0]).not.toHaveProperty("outputChannels");
    } finally {
      await fixture.dispose();
    }
  });
});
