import { afterEach, describe, expect, it } from "vitest";
import { validateToolNormalInvocationInput, validateToolNormalInvocationPayload } from "../../capabilities/normal-invocation/validator.js";
import { resolveAutomationBinding } from "../automations/binding-resolution.js";
import { readAutomationCatalog } from "../automations/catalog.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationDraftRecord } from "../automations/storage-records.js";
import { findAutomationStep } from "../automations/step-evidence-effects.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { createDefaultToolRegistry } from "../default-environment-adapters.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type Receipt = { automationId: string; revision: number; rootSequenceId: string; aliases: Record<string, string>;
  draft: AutomationDraftRecord; operationRefs: string[] };
const fixtures: Fixture[] = [];
const operation = { toolName: "web_search", operationId: "search_many", contractVersion: 1 };

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
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
  const call = (action: string, params: Record<string, unknown>, plan: unknown) => registry.execute({
    tool: "automation_builder", params: { action, ...params, planJson: JSON.stringify(plan) },
  });
  return { fixture, service, registry, call };
}

function researchPlan() {
  return { version: 1, commands: [
    { as: "search", mutation: { kind: "add_node", parentSequenceId: "$root", index: 0,
      nodeWithoutId: { kind: "tool", title: "Research", onFailure: "stop", operation,
        controls: { queries: { kind: "literal", value: ["Technology"] } } } } },
    { as: "summary", mutation: { kind: "add_node", parentSequenceId: "$root", index: 1,
      nodeWithoutId: { kind: "agent", title: "Summary", onFailure: "stop", modelProfileId: "scheduled-model",
        agentMode: "fast", roleInstructions: "Summarize evidence", prompt: "Preserve source URLs",
        inputs: { source: { kind: "node_result", nodeId: "$search", select: "text" },
          unchangedLiteral: { kind: "literal", value: "$search" } },
        tools: [{ operation, usage: "available" }], result: { kind: "text" } } } },
  ] };
}

describe("automation builder tool boundary", () => {
  it("registers bounded payload operations with complete selection controls", async () => {
    const f = await setup();
    expect(f.registry.getDefinition("automation_builder")).toMatchObject({
      name: "automation_builder", controlsRefinement: "mechanical_when_complete",
      catalogGroups: ["automations"],
    });
    const contract = f.registry.listNormalInvocations!().find((item) => item.toolName === "automation_builder")!.contract;
    expect(contract.operations.map((item) => item.operationId)).toEqual([
      "create_automation_draft", "apply_automation_draft_changes",
    ]);
    for (const selected of contract.operations) {
      expect(selected.selectionControlIds).toEqual(selected.input.required);
      expect(selected.effect).toBe("mutating");
      expect(selected.payload).toMatchObject({ kind: "raw_text", param: "planJson", maxBytes: 32 * 1024 });
      expect(validateToolNormalInvocationPayload(selected, undefined)).toBeDefined();
      expect(validateToolNormalInvocationPayload(selected, JSON.stringify(researchPlan()))).toBeUndefined();
      expect(validateToolNormalInvocationPayload(selected, "א".repeat(16_385))).toBeDefined();
    }
    const create = contract.operations[0]!;
    expect(validateToolNormalInvocationInput(create, { title: "Research" }).ok).toBe(true);
    expect(validateToolNormalInvocationInput(create, {}).ok).toBe(false);
    const apply = contract.operations[1]!;
    expect(validateToolNormalInvocationInput(apply, { automationId: "exact", expectedRevision: 1 }).ok).toBe(true);
    expect(validateToolNormalInvocationInput(apply, { automationId: "exact" }).ok).toBe(false);
    expect(createDefaultToolRegistry(f.fixture.config).getDefinition("automation_builder")).toBeUndefined();
  });

  it("creates a connected draft atomically and returns its saved state and continuation identities", async () => {
    const f = await setup();
    const result = await f.call("create_automation_draft", { title: "Research" }, researchPlan());
    expect(result.ok, result.error).toBe(true);
    expect(result.data).toMatchObject({ mutationEvidence: true, currentStateEvidence: true });
    const receipt = JSON.parse(result.output) as Receipt;
    expect(Object.keys(receipt).sort()).toEqual([
      "aliases", "automationId", "draft", "operationRefs", "preparation", "revision", "rootSequenceId",
    ]);
    expect(receipt.revision).toBe(1);
    expect(receipt.aliases.root).toBe(receipt.rootSequenceId);
    const draft = (await f.service.getDraft(receipt.automationId))!;
    expect(receipt.draft).toEqual(draft);
    expect(receipt.operationRefs).toEqual(["web_search/search_many@1"]);
    expect(receipt.draft.definition.body.children).toHaveLength(2);
    expect(draft.definition.body.children.map((node) => node.id)).toEqual([receipt.aliases.search, receipt.aliases.summary]);
    const summary = findAutomationStep(draft.definition.body, receipt.aliases.summary!)!;
    if (summary.kind !== "agent") throw new Error("expected_agent");
    expect(summary.inputs.unchangedLiteral).toEqual({ kind: "literal", value: "$search" });
    expect(resolveAutomationBinding(summary.inputs.source!, { runInputs: {}, sourceFiles: [], branchResults: new Map(),
      nodeResults: new Map([[receipt.aliases.search!, { status: "succeeded", text: "Source evidence" }]]) }))
      .toEqual({ ok: true, value: "Source evidence" });
    expect(await f.service.getGrant(receipt.automationId)).toBeNull();
    expect(await f.fixture.scheduler.getAutomationJob(receipt.automationId)).toBeNull();

    const changed = await f.call("apply_automation_draft_changes", {
      automationId: receipt.automationId, expectedRevision: receipt.revision,
    }, { version: 1, commands: [{ mutation: { kind: "update_node", nodeId: receipt.aliases.summary,
      patch: { title: "Edited summary" } } }, { mutation: { kind: "update_definition", patch: { objective: "Keep sources" } } }] });
    expect(changed.ok, changed.error).toBe(true);
    expect(JSON.parse(changed.output)).toMatchObject({ automationId: receipt.automationId,
      revision: 2, rootSequenceId: receipt.rootSequenceId });
    expect(JSON.parse(changed.output).draft).toEqual(await f.service.getDraft(receipt.automationId));
    expect((await f.service.getDraft(receipt.automationId))?.definition.objective).toBe("Keep sources");
  });

  it("accepts a recipe only for creation and retains the exact draft when a recipe is sent to apply", async () => {
    const f = await setup();
    const recipe = { version: 1, settings: { objective: "Connected recipe" }, steps: [
      { key: "search", kind: "tool", title: "Research", operation,
        controls: { queries: { kind: "literal", value: ["Technology"] } } },
      { key: "summary", kind: "agent", title: "Summary", modelProfileId: "scheduled-model", prompt: "Summarize supplied evidence.",
        inputs: { source: { kind: "node_result", nodeId: "$search", select: "text" } } },
    ] };
    const created = await f.call("create_automation_draft", { title: "Recipe" }, recipe);
    expect(created.ok, created.error).toBe(true);
    expect(created.data).toMatchObject({ mutationEvidence: true, currentStateEvidence: true });
    const receipt = JSON.parse(created.output) as Receipt;
    expect(receipt.revision).toBe(1);
    expect(receipt.aliases.root).toBe(receipt.rootSequenceId);
    const before = (await f.service.getDraft(receipt.automationId))!;
    expect(before.definition.body.children.map(({ id }) => id)).toEqual([receipt.aliases.search, receipt.aliases.summary]);
    expect(before.definition.body.children[1]).toMatchObject({ agentMode: "fast", onFailure: "stop",
      result: { kind: "text" }, inputs: { source: { nodeId: receipt.aliases.search } } });
    const selection = { automationId: receipt.automationId, expectedRevision: receipt.revision };
    const rejected = await f.call("apply_automation_draft_changes", selection, {
      ...recipe, settings: { objective: "Must not persist" },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.data).toMatchObject({ mutationEvidence: false });
    expect(JSON.parse(rejected.output)).toMatchObject({ code: "automation_batch_field_unknown", path: "plan.settings" });
    expect(await f.service.getDraft(receipt.automationId)).toEqual(before);
    expect(await f.service.list()).toHaveLength(1);
    const applied = await f.call("apply_automation_draft_changes", selection, { version: 1,
      commands: [{ mutation: { kind: "update_definition", patch: { objective: "Canonical edit" } } }] });
    expect(applied.ok, applied.error).toBe(true);
    expect(JSON.parse(applied.output)).toMatchObject({ automationId: receipt.automationId, revision: 2,
      rootSequenceId: receipt.rootSequenceId });
    expect((await f.service.getDraft(receipt.automationId))?.definition.body).toEqual(before.definition.body);
    expect(await f.service.getGrant(receipt.automationId)).toBeNull();
    expect(await f.fixture.scheduler.getAutomationJob(receipt.automationId)).toBeNull();
    expect(await f.service.listRuns(receipt.automationId)).toEqual([]);
  });

  it("reports rejected plans without mutation evidence or partially saving changes", async () => {
    const f = await setup();
    const created = await f.call("create_automation_draft", { title: "Research" }, researchPlan());
    expect(created.ok, created.error).toBe(true);
    const receipt = JSON.parse(created.output) as Receipt;
    const before = await f.service.getDraft(receipt.automationId);
    const controls = { automationId: receipt.automationId, expectedRevision: receipt.revision };
    const rejected = await f.call("apply_automation_draft_changes", controls, { version: 1, commands: [
      { mutation: { kind: "update_definition", patch: { title: "Must not persist" } } },
      { mutation: { kind: "update_node", nodeId: "$missing", patch: { title: "Invalid" } } },
    ] });
    expect(rejected.ok).toBe(false);
    expect(rejected.data?.mutationEvidence).not.toBe(true);
    expect(rejected.output).toContain("commands.1");
    expect(await f.service.getDraft(receipt.automationId)).toEqual(before);
    const malformed = await f.call("apply_automation_draft_changes", controls, { version: 1, commands: [
      { mutation: { kind: "update_node", nodeId: receipt.aliases.summary, patch: { inputs: {
        bad: { kind: "node_result", nodeId: receipt.aliases.search, select: "unknown" },
      } } } },
    ] });
    expect(malformed.ok).toBe(false);
    expect(JSON.parse(malformed.output)).toMatchObject({ code: "automation_graph_invalid",
      path: "body.children.1.inputs.bad.select", commandPath: "plan.commands.0.mutation" });
    expect(await f.service.getDraft(receipt.automationId)).toEqual(before);
    const changed = await f.call("apply_automation_draft_changes", controls, { version: 1,
      commands: [{ mutation: { kind: "update_definition", patch: { objective: "Newer edit" } } }] });
    expect(changed.ok).toBe(true);
    const stale = await f.call("apply_automation_draft_changes", controls, { version: 1,
      commands: [{ mutation: { kind: "update_definition", patch: { objective: "Stale edit" } } }] });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("automation_revision_conflict");
    expect(stale.data?.mutationEvidence).not.toBe(true);
    expect((await f.service.getDraft(receipt.automationId))?.definition.objective).toBe("Newer edit");
  });

  it("rejects malformed or oversized raw payloads before creating any draft", async () => {
    const f = await setup();
    for (const planJson of [undefined, "not-json", "א".repeat(16_385)]) {
      const result = await f.registry.execute({ tool: "automation_builder",
        params: { action: "create_automation_draft", title: "Invalid", planJson } });
      expect(result.ok).toBe(false);
      expect(result.data?.mutationEvidence).not.toBe(true);
      expect(await f.service.list()).toEqual([]);
    }
  });

  it("returns bounded canonical graph issues without creating a rejected draft", async () => {
    const f = await setup();
    const plan = researchPlan();
    const rejected = await f.call("create_automation_draft", { title: "Invalid dependency" }, {
      ...plan, commands: [...plan.commands, { mutation: { kind: "update_node", nodeId: "$summary",
        patch: { inputs: { missing: { kind: "node_result", nodeId: "missing", select: "text" } } } } }],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.data?.mutationEvidence).toBe(false);
    const detail = JSON.parse(rejected.output);
    expect(detail).toMatchObject({ code: "automation_dependency_missing",
      issues: [expect.objectContaining({ code: "automation_dependency_missing" })], omittedIssueCount: 0 });
    expect(await f.service.list()).toEqual([]);
  });

  it("excludes both builder operations from tools selectable inside automations", async () => {
    const f = await setup();
    expect(f.registry.listNormalInvocations!().some((item) => item.toolName === "automation_builder")).toBe(true);
    const persistence: AutomationPersistence = { read: async () => emptyAutomationJournalState(),
      update: async () => { throw new Error("unexpected_mutation"); },
      updateWithScheduler: async () => { throw new Error("unexpected_mutation"); } };
    const catalog = await readAutomationCatalog({ automationId: "draft", environmentId: f.fixture.config.runtimeId,
      config: f.fixture.config, tools: f.registry, persistence });
    expect(catalog.grantableOperations.some((item) =>
      ["automation_builder", "automations", "schedules"].includes(item.toolName))).toBe(false);
    expect(catalog.operations.some((item) => item.toolName === "automation_builder")).toBe(false);
  });
});
