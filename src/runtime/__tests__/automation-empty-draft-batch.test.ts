import { describe, expect, it } from "vitest";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { createAutomationSavedAgentManager } from "../automations/saved-agent-management.js";
import type { AutomationService } from "../automations/service.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { createAutomationBuilderToolModule } from "../capabilities/automation-builder/tool-module.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";

function fixture() {
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
  const saved = createAutomationSavedAgentManager({ persistence });
  const service = { createDraftPlan: drafts.createPlan, applyDraftPlan: drafts.applyPlan,
    getDraft: drafts.get, updateDraft: drafts.update, getSavedAgent: saved.get,
  } as unknown as AutomationService;
  const builder = createAutomationBuilderToolModule(() => service, async () => undefined);
  const edits = createAutomationDraftToolModule(() => service, async () => undefined);
  return { drafts, saved, builder, edits, snapshot: () => structuredClone(state) };
}

const node = { kind: "agent", title: "Saved configuration", onFailure: "stop", modelProfileId: "model",
  agentMode: "fast", roleInstructions: "Analyze supplied evidence", prompt: "Version one task",
  inputs: {}, tools: [], result: { kind: "text" } };
const addedNode = { as: "agent", mutation: { kind: "add_node", parentSequenceId: "$root", index: 0, nodeWithoutId: node } };
const plan = (commands: readonly unknown[]) => ({ version: 1, commands });
const metadata = { mutation: { kind: "update_definition", patch: { objective: "Requested workflow" } } };

describe("empty draft batch compatibility", () => {
  it("creates metadata only and then reuses the exact saved-agent revision without a placeholder", async () => {
    const f = fixture();
    const source = await f.drafts.createPlan("Reusable source", plan([addedNode]));
    const first = await f.saved.saveFromDraft({ automationId: source.draft.automationId,
      nodeId: source.aliases.agent!, expectedDraftRevision: 1 });
    await f.drafts.applyPlan(source.draft.automationId, 1, plan([{ mutation: {
      kind: "update_node", nodeId: source.aliases.agent, patch: { prompt: "Version two task" },
    } }]));
    await f.saved.saveFromDraft({ automationId: source.draft.automationId,
      nodeId: source.aliases.agent!, expectedDraftRevision: 2,
      agentId: first.agentId, expectedAgentRevision: 1 });

    const created = await f.builder.implementation({ action: "create_automation_draft",
      title: "Reuse only", planJson: JSON.stringify(plan([metadata])) });
    expect(created.ok, created.error).toBe(true);
    const receipt = JSON.parse(created.output);
    const empty = (await f.drafts.get(receipt.automationId))!;
    expect(empty.definition.body.children).toEqual([]);
    expect(receipt).toMatchObject({ revision: 1, aliases: { root: empty.definition.body.id } });
    expect(compileAutomationGraph(empty.definition)).toMatchObject({ ok: false,
      issues: [{ code: "automation_graph_empty" }] });
    const reused = await f.edits.implementation({ action: "add_saved_agent",
      automationId: receipt.automationId, expectedRevision: receipt.revision,
      parentSequenceId: receipt.rootSequenceId, index: 0,
      agentId: first.agentId, agentRevision: first.revision });
    expect(reused.ok, reused.error).toBe(true);
    const completed = (await f.drafts.get(receipt.automationId))!;
    expect(completed.revision).toBe(2);
    expect(completed.definition.body.children).toHaveLength(1);
    expect(completed.definition.body.children[0]).toMatchObject({ prompt: "Version one task",
      savedAgentOrigin: { agentId: first.agentId, revision: 1 } });
    expect(completed.definition.body.children[0]!.id).not.toBe(first.agent.id);
    expect(f.snapshot()).toMatchObject({ definitions: [], grants: [], executions: [] });
  });

  it("removes the final step atomically while keeping its incomplete draft editable", async () => {
    const f = fixture();
    const created = await f.drafts.createPlan("Reset me", plan([metadata, addedNode]));
    const emptied = await f.drafts.applyPlan(created.draft.automationId, 1, plan([{ mutation: {
      kind: "remove_node", nodeId: created.aliases.agent,
    } }]));
    expect(emptied.draft.revision).toBe(2);
    expect(emptied.draft.definition.body.children).toEqual([]);
    expect(emptied.draft.definition.objective).toBe("Requested workflow");
    expect(emptied.aliases).toEqual({ root: created.aliases.root });
    expect(compileAutomationGraph(emptied.draft.definition)).toMatchObject({ ok: false,
      issues: [{ code: "automation_graph_empty" }] });
    const edited = await f.drafts.applyPlan(created.draft.automationId, 2, plan([{ mutation: {
      kind: "update_definition", patch: { title: "New draft title" },
    } }]));
    expect(edited.draft.definition.title).toBe("New draft title");
    expect(edited.draft.revision).toBe(3);
    expect(f.snapshot()).toMatchObject({ definitions: [], grants: [], executions: [] });
  });

  it.each([
    { code: "automation_source_unavailable", patch: {
      trigger: { kind: "folder", checkEveryMs: 300_000, minimumEligibleFiles: 1 },
    } },
    { code: "automation_limits_invalid", patch: {
      limits: { ...DEFAULT_AUTOMATION_LIMITS, maxConcurrentNodes: 65 },
    } },
  ])("rejects an empty draft with $code without saving any command", async ({ patch, code }) => {
    const f = fixture();
    const invalid = { mutation: { kind: "update_definition", patch } };
    await expect(f.drafts.createPlan("Invalid", plan([metadata, invalid])))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
    expect(f.snapshot().drafts).toEqual([]);
    const created = await f.drafts.createPlan("Keep", plan([addedNode]));
    const before = f.snapshot();
    await expect(f.drafts.applyPlan(created.draft.automationId, 1, plan([
      { mutation: { kind: "remove_node", nodeId: created.aliases.agent } }, invalid,
    ]))).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
    expect(f.snapshot()).toEqual(before);
  });

  it("does not treat a nested empty structure as a deliberately empty root", async () => {
    const f = fixture();
    const malformed = await f.drafts.create("Nested empty", (empty) => ({ ...empty,
      body: { ...empty.body, children: [{ kind: "sequence", id: "nested", children: [] }] },
    }));
    const before = f.snapshot();
    await expect(f.drafts.applyPlan(malformed.automationId, 1, plan([metadata])))
      .rejects.toMatchObject({ code: "automation_graph_empty" });
    expect(f.snapshot()).toEqual(before);
  });
});
