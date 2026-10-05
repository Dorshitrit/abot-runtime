import { afterEach, describe, expect, it } from "vitest";
import { buildToolCompletedEventMetadata, buildToolStartEventMetadata } from "../../capabilities/tool-event-metadata.js";
import { createDefaultToolRegistry } from "../default-environment-adapters.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    expect(fixture.invoke).not.toHaveBeenCalled();
    await fixture.dispose();
  }
});

async function setup() {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const service = fixture.application.services.automations!;
  const registry = createDefaultToolRegistry(fixture.config, undefined, {
    getService: () => service, ready: async () => undefined,
  });
  async function call(tool: string, params: Record<string, unknown>) {
    const invocation = { tool, params };
    const definition = registry.getDefinition(tool);
    const started = buildToolStartEventMetadata(invocation, definition);
    const result = await registry.execute(invocation);
    const completed = buildToolCompletedEventMetadata(invocation, result, definition);
    return { started, result, completed };
  }
  return { service, call };
}

const recipe = {
  version: 1,
  steps: [{ key: "research", kind: "tool", title: "Find evidence",
    operation: { toolName: "web_search", operationId: "search_many", contractVersion: 1 },
    controls: { queries: { kind: "literal", value: ["private research question"] } } }],
};

describe("automation tool client event evidence", () => {
  it("keeps client metadata separate from canonical authoring receipts", async () => {
    const f = await setup();
    const planJson = JSON.stringify(recipe);
    const created = await f.call("automation_builder", { action: "create_automation_draft",
      title: "Weekly research", planJson });
    expect(created.result.ok, created.result.error).toBe(true);
    const receipt = JSON.parse(created.result.output);
    expect(created.started).toMatchObject({ automationAction: "create_automation_draft",
      automationTitle: "Weekly research", inputPreview: planJson, contentLength: planJson.length });
    expect(created.completed).toMatchObject({ outputPreview: created.result.output.slice(0, 1_200),
      outputPreviewTruncated: true });
    expect(created.result.data).toEqual({ mutationEvidence: true, currentStateEvidence: true });
    expect(Object.keys(receipt).sort()).toEqual([
      "aliases", "automationId", "draft", "operationRefs", "preparation", "revision", "rootSequenceId",
    ]);

    const updated = await f.call("automation_builder", { action: "apply_automation_draft_changes",
      automationId: receipt.automationId, expectedRevision: 1,
      planJson: JSON.stringify({ version: 1, commands: [{ mutation: { kind: "update_definition",
        patch: { title: "Updated research", objective: "Keep verified sources" } } }] }) });
    expect(updated.result.ok, updated.result.error).toBe(true);
    expect(updated.completed).toMatchObject({ automationId: receipt.automationId,
      expectedRevision: 1, outputPreview: updated.result.output.slice(0, 1_200), outputPreviewTruncated: true });
    expect(JSON.parse(updated.result.output)).toMatchObject({
      automationId: receipt.automationId, revision: 2,
    });
    expect(updated.result.data).toEqual({ mutationEvidence: true, currentStateEvidence: true });
    expect(await f.service.getGrant(receipt.automationId)).toBeNull();
    expect(await f.service.listRuns(receipt.automationId)).toEqual([]);
  });

  it("shows the recorded results of draft reads, catalog discovery and preparation", async () => {
    const f = await setup();
    const created = await f.call("automation_builder", { action: "create_automation_draft",
      title: "Draft to inspect", planJson: JSON.stringify(recipe) });
    expect(created.result.ok, created.result.error).toBe(true);
    const automationId = JSON.parse(created.result.output).automationId;
    const read = await f.call("automations", { action: "read_draft", automationId });
    expect(read.completed).toMatchObject({ automationAction: "read_draft", automationId });
    expect(read.completed!.outputPreview).toBe(read.result.output.slice(0, 1_200));
    expect(read.result.data).toEqual({ mutationEvidence: false, currentStateEvidence: true });
    const catalog = await f.call("automations", { action: "browse_catalog", view: "index", offset: 0 });
    expect(catalog.completed).toMatchObject({ automationAction: "browse_catalog", view: "index", offset: 0 });
    expect(catalog.completed!.outputPreview).toBe(catalog.result.output.slice(0, 1_200));
    const prepare = await f.call("automations", { action: "prepare_draft", operationRefs: [] });
    expect(prepare.result.ok, prepare.result.error).toBe(true);
    expect(prepare.completed!.outputPreview).toBe(prepare.result.output.slice(0, 1_200));
    expect(prepare.completed!.outputPreviewTruncated).toBe(true);
    const validate = await f.call("automations", { action: "validate_draft", automationId });
    expect(validate.completed!.outputPreview).toBe(validate.result.output.slice(0, 1_200));
    const list = await f.call("automations", { action: "list_drafts" });
    expect(list.completed!.outputPreview).toContain("Draft to inspect");
  });

  it("shows a failed builder receipt using the same returned-excerpt channel", async () => {
    const f = await setup();
    const rejected = await f.call("automation_builder", { action: "create_automation_draft",
      title: "Rejected", planJson: JSON.stringify({ version: 1, commands: [
        { as: "invalid_alias", mutation: { kind: "update_definition", patch: { title: "Uncommitted" } } },
      ] }) });
    expect(rejected.result.ok).toBe(false);
    expect(JSON.parse(String(rejected.completed!.outputPreview))).toMatchObject({
      code: "automation_batch_alias_target_invalid", path: "plan.commands.0.as",
    });
    expect(rejected.result.data).toEqual({ mutationEvidence: false });
    expect(await f.service.list()).toEqual([]);
    const missing = await f.call("automations", { action: "read_draft", automationId: "missing" });
    expect(missing.completed!.outputPreview).toBe("automation_not_found");
    expect(missing.result.data).toBeUndefined();
  });

  it("clips client excerpts without clipping the accepted plan or canonical result", async () => {
    const f = await setup();
    const longRecipe = structuredClone(recipe);
    longRecipe.steps[0]!.controls.queries.value = ["x".repeat(3_000)];
    const planJson = JSON.stringify(longRecipe);
    const created = await f.call("automation_builder", { action: "create_automation_draft",
      title: "Long plan", planJson });
    expect(created.result.ok, created.result.error).toBe(true);
    expect(created.started).toMatchObject({ inputPreview: planJson.slice(0, 500),
      inputPreviewTruncated: true, contentLength: planJson.length });
    const automationId = JSON.parse(created.result.output).automationId;
    const read = await f.call("automations", { action: "read_draft", automationId });
    expect(read.result.output).toContain("x".repeat(3_000));
    expect(read.completed).toMatchObject({ outputPreview: read.result.output.slice(0, 1_200),
      outputPreviewTruncated: true });
    expect(read.result.data).toEqual({ mutationEvidence: false, currentStateEvidence: true });
  });
});
