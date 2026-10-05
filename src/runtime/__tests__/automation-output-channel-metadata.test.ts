import { describe, expect, it, vi } from "vitest";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { discoverAgentPluginManifests } from "../plugins/manifest-discovery.js";
import { projectManifestRuntimeContract } from "../plugins/manifest-projection.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

describe("automation plugin output-channel metadata", () => {
  it("preserves canonical operation descriptions from the real manifest through preparation without executing tools", async () => {
    const discovered = discoverAgentPluginManifests(process.cwd())
      .find(({ manifest }) => manifest.name === "web")!;
    const source = discovered.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities.web_search!;
    const projected = projectManifestRuntimeContract(discovered, ["web_search"]);
    const executeFutureTool = vi.fn(async () => { throw new Error("unexpected_workflow_execution"); });
    const registry = createConfiguredToolRegistry(undefined, projected.capabilities.map((capability) => ({
      ...capability, implementation: executeFutureTool,
    })));
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, registry);
    try {
      const service = fixture.application.services.automations!;
      const operationIds = Object.keys(source.operations);
      const prepared = await readAutomationAuthoringPreparation(service, {
        operationRefs: operationIds.map((id) => `web_search/${id}@1`),
      });
      expect(prepared.operations.map(({ operationId, label }) => [operationId, label]))
        .toEqual(operationIds.map((id) => [id, source.operations[id]!.summary]));
      expect(prepared.authoringReference).toBe(AUTOMATION_AUTHORING_REFERENCE);
      expect(prepared.authoringReference.bindings.examples.earlierWholeData)
        .toEqual({ kind: "node_result", nodeId: "$first", select: "data" });
      expect(prepared).toMatchObject({ grantsPermissions: false, executesWorkflow: false });
      expect(prepared.operations.every(({ granted }) => !granted)).toBe(true);
      expect(executeFutureTool).not.toHaveBeenCalled();
      expect(fixture.invoke).not.toHaveBeenCalled();
      expect(fixture.invokeRaw).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });
});
