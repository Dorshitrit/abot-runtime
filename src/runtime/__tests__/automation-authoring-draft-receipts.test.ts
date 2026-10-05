import { describe, expect, it, vi } from "vitest";
import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/validator.js";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationService } from "../automations/service.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { AUTOMATION_AUTHORING_REFERENCE as reference } from "../capabilities/automation-builder/authoring-reference.js";
import { createAutomationBuilderToolModule } from "../capabilities/automation-builder/tool-module.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import { AUTOMATION_AUTHORING_PREPARATION_LIMITS } from "../capabilities/automations/authoring-preparation-limits.js";

function fixture(operationNames = ["catalog_tool", "writer"]) {
  let state = emptyAutomationJournalState();
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const next = structuredClone(state);
      const result = mutate(next);
      state = next;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
  const drafts = createAutomationDraftManager({ persistence });
  const operation = reference.nodes.operationReference;
  const catalog = vi.fn(async () => ({ operations: [], grantableOperations: operationNames.map((toolName) => ({
    ...operation, toolName, label: "Read", catalogGroups: ["files"], toolDescription: "Read evidence",
    permissionMode: "full", effect: "read_only", approval: "request_policy", fixedParams: {},
    input: { type: "object", additionalProperties: false, properties: {}, required: [] },
  })), models: [], savedAgents: [], templates: [] }));
  const getDraft = vi.fn(drafts.get);
  const applyDraftPlan = vi.fn(drafts.applyPlan);
  const service = { getDraft, createDraftPlan: drafts.createPlan, applyDraftPlan, catalog } as unknown as AutomationService;
  const builder = createAutomationBuilderToolModule(() => service, async () => undefined);
  const reader = createAutomationDraftToolModule(() => service, async () => undefined);
  return { drafts, builder, reader, getDraft, applyDraftPlan, service, catalog };
}

const initialPlan = { version: 1, commands: [
  { as: "read", mutation: { kind: "add_node", parentSequenceId: "$root", index: 0,
    nodeWithoutId: reference.nodes.tool } },
  { as: "agent", mutation: { kind: "add_node", parentSequenceId: "$root", index: 1,
    nodeWithoutId: { ...reference.nodes.agent, tools: [
      { operation: reference.nodes.operationReference, usage: "available" },
      { operation: { ...reference.nodes.operationReference, toolName: "writer" }, usage: "available" },
    ] } } },
  { as: "parallel", mutation: { kind: "wrap_parallel", nodeIds: ["$read", "$agent"] } },
] };

async function create(f: ReturnType<typeof fixture>, plan: unknown = initialPlan) {
  const result = await f.builder.implementation({ action: "create_automation_draft", title: "QA",
    planJson: JSON.stringify(plan) });
  expect(result.ok).toBe(true);
  return JSON.parse(result.output) as {
    automationId: string; revision: number; aliases: Record<string, string>;
    draft: Awaited<ReturnType<typeof f.drafts.create>>; operationRefs: string[];
    preparation: { operationRefLimit: number; requiresSelection: boolean };
  };
}

describe("automation authoring draft receipts", () => {
  it("returns the saved draft and deduplicated nested operation refs for preparation without catalog rediscovery", async () => {
    const f = fixture();
    const created = await create(f);
    expect(f.getDraft).not.toHaveBeenCalled();
    expect(f.catalog).not.toHaveBeenCalled();
    expect(created.draft).toEqual(await f.drafts.get(created.automationId));
    expect(created.operationRefs).toEqual(["catalog_tool/catalog_operation@1", "writer/catalog_operation@1"]);
    expect(created.preparation).toEqual({ operationRefLimit: 16, requiresSelection: false });

    const read = await f.reader.implementation({ action: "read_draft", automationId: created.automationId });
    expect(read.ok).toBe(true);
    expect(JSON.parse(read.output)).toEqual({ draft: created.draft, operationRefs: created.operationRefs,
      preparation: created.preparation });
    const prepared = await readAutomationAuthoringPreparation(f.service, { operationRefs: created.operationRefs });
    expect(prepared.operations.map(({ ref }) => ref)).toEqual(created.operationRefs);
    expect(f.catalog).toHaveBeenCalledExactlyOnceWith("");
  });

  it.each([0, 16, 17])("keeps all %i draft refs and prepares bounded selections without rediscovery or mutation", async (count) => {
    const names = Array.from({ length: count }, (_, index) => `tool_${index}`);
    const f = fixture(names);
    const tools = names.map((toolName) => ({
      operation: { ...reference.nodes.operationReference, toolName }, usage: "available",
    }));
    const created = await create(f, { version: 1, commands: [{ as: "agent", mutation: {
      kind: "add_node", parentSequenceId: "$root", index: 0,
      nodeWithoutId: { ...reference.nodes.agent, tools },
    } }] });
    const refs = names.map((name) => `${name}/catalog_operation@1`);
    const limit = AUTOMATION_AUTHORING_PREPARATION_LIMITS.operationRefs;
    expect(created.operationRefs).toEqual(refs);
    expect(created.preparation).toEqual({ operationRefLimit: limit, requiresSelection: count > limit });
    expect(f.catalog).not.toHaveBeenCalled();
    const read = await f.reader.implementation({ action: "read_draft", automationId: created.automationId });
    expect(JSON.parse(read.output)).toEqual({ draft: created.draft, operationRefs: refs,
      preparation: created.preparation });
    const contract = f.reader.normalInvocation!.operations.find(({ operationId }) => operationId === "prepare_draft")!;
    expect(contract.input.properties.operationRefs).toMatchObject({ maxItems: limit });
    expect(validateToolNormalInvocationInput(contract, { operationRefs: refs }).ok).toBe(count <= limit);
    if (count > limit) {
      await expect(readAutomationAuthoringPreparation(f.service, { operationRefs: refs }))
        .rejects.toThrow("automation_preparation_operation_refs_invalid");
      expect(f.catalog).not.toHaveBeenCalled();
    }
    const resolved: string[] = [];
    for (let offset = 0; offset < Math.max(1, refs.length); offset += limit) {
      const selection = refs.slice(offset, offset + limit);
      expect(validateToolNormalInvocationInput(contract, { operationRefs: selection }).ok).toBe(true);
      const result = await f.reader.implementation({ action: "prepare_draft", operationRefs: selection });
      expect(result.ok).toBe(true);
      const prepared = JSON.parse(result.output);
      expect(prepared).toMatchObject({ grantsPermissions: false, executesWorkflow: false });
      resolved.push(...prepared.operations.map(({ ref }: { ref: string }) => ref));
    }
    expect(resolved).toEqual(refs);
    expect(f.catalog).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / limit)));
    expect(await f.drafts.get(created.automationId)).toEqual(created.draft);
    expect(f.applyDraftPlan).not.toHaveBeenCalled();
  });

  it("returns the exact committed revision without reading a later concurrent draft", async () => {
    const f = fixture();
    const created = await create(f);
    f.applyDraftPlan.mockImplementationOnce(async (...args) => {
      const saved = await f.drafts.applyPlan(...args);
      await f.drafts.update(saved.draft.automationId, saved.draft.revision, { kind: "update_node",
        nodeId: created.aliases.agent!, patch: { tools: Array.from({ length: 17 }, (_, index) => ({
          operation: { ...reference.nodes.operationReference, toolName: `later_${index}` }, usage: "available",
        })) } });
      return saved;
    });
    const result = await f.builder.implementation({ action: "apply_automation_draft_changes",
      automationId: created.automationId, expectedRevision: 1,
      planJson: JSON.stringify({ version: 1, commands: [{ mutation: {
        kind: "update_node", nodeId: created.aliases.agent, patch: { prompt: "Updated assignment" },
      } }] }) });
    expect(result.ok).toBe(true);
    const receipt = JSON.parse(result.output);
    expect(receipt).toMatchObject({ revision: 2, draft: { revision: 2, definition: { title: "QA" } } });
    expect(JSON.stringify(receipt.draft)).toContain("Updated assignment");
    expect(receipt.operationRefs).toEqual(created.operationRefs);
    expect(receipt.preparation).toEqual(created.preparation);
    const later = await f.drafts.get(created.automationId);
    expect(later).toMatchObject({ revision: 3 });
    expect(JSON.stringify(later)).toContain("later_16");
    expect(JSON.stringify(receipt)).not.toContain("later_16");
    expect(f.getDraft).not.toHaveBeenCalled();
  });

  it("returns no saved draft and makes no change after a revision conflict", async () => {
    const f = fixture();
    const created = await create(f);
    const result = await f.builder.implementation({ action: "apply_automation_draft_changes",
      automationId: created.automationId, expectedRevision: 2,
      planJson: JSON.stringify({ version: 1, commands: [{ mutation: {
        kind: "update_definition", patch: { title: "Rejected" },
      } }] }) });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.output)).toEqual({ code: "automation_revision_conflict" });
    expect(await f.drafts.get(created.automationId)).toEqual(created.draft);
  });
});
