import { describe, expect, it } from "vitest";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";

function createTestPersistence(): AutomationPersistence {
  let state = emptyAutomationJournalState();
  return {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const copy = structuredClone(state);
      const result = mutate(copy);
      state = copy;
      return result;
    },
    updateWithScheduler: async () => {
      throw new Error("unexpected_scheduler_mutation");
    },
  };
}

const tool = (title: string) => ({
  kind: "tool", title, onFailure: "stop",
  operation: { toolName: "example", operationId: "read", contractVersion: 1 },
  controls: {},
});

describe("automation draft management", () => {
  it("lists the latest saved edit time without changing it on reads", async () => {
    let now = Date.parse("2026-10-01T09:00:00Z");
    const manager = createAutomationDraftManager({ persistence: createTestPersistence(), now: () => now });
    const initial = await manager.create("Original title");
    expect(await manager.list()).toEqual([expect.objectContaining({ updatedAt: initial.updatedAt })]);
    now += 60_000;
    const changed = await manager.update(initial.automationId, initial.revision, {
      kind: "update_definition", patch: { title: "Edited title" },
    });
    expect(changed.updatedAt).not.toBe(initial.updatedAt);
    now += 60_000;
    expect(await manager.list()).toEqual([expect.objectContaining({
      id: initial.automationId, title: "Edited title", updatedAt: changed.updatedAt,
    })]);
  });

  it("keeps a newly dragged Tool incomplete until an operation is chosen", async () => {
    const manager = createAutomationDraftManager({ persistence: createTestPersistence() });
    const initial = await manager.create("Choose operation later");
    const added = await manager.update(initial.automationId, initial.revision, {
      kind: "add_node", parentSequenceId: initial.definition.body.id, index: 0,
      nodeWithoutId: { ...tool("Web Fetch"), operation: {
        toolName: "web_fetch", operationId: "", contractVersion: 1,
      } },
    });
    const node = added.definition.body.children[0]!;
    expect(compileAutomationGraph(added.definition)).toMatchObject({ ok: false });
    const configured = await manager.update(initial.automationId, added.revision, {
      kind: "update_node", nodeId: node.id,
      patch: { operation: { toolName: "web_fetch", operationId: "fetch_one", contractVersion: 1 } },
    });
    expect(compileAutomationGraph(configured.definition).ok).toBe(true);
  });

  it("preserves the current draft when a second editor submits a stale revision", async () => {
    const manager = createAutomationDraftManager({ persistence: createTestPersistence(), now: () => 1_000 });
    const initial = await manager.create("Document intake");
    const changed = await manager.update(initial.automationId, 1, {
      kind: "add_node", parentSequenceId: initial.definition.body.id,
      index: 0, nodeWithoutId: tool("Read source"),
    });
    await expect(manager.update(initial.automationId, 1, {
      kind: "update_definition", patch: { title: "stale overwrite" },
    })).rejects.toThrow("automation_revision_conflict");
    expect((await manager.get(initial.automationId))?.definition).toEqual(changed.definition);
    expect(changed.definition.body.children[0]?.id).toMatch(/^n_/u);
  });

  it("wraps adjacent steps into parallel branches with one shared continuation", async () => {
    const manager = createAutomationDraftManager({ persistence: createTestPersistence() });
    const initial = await manager.create("Parallel intake");
    let draft = initial;
    for (const title of ["Read A", "Read B", "Continue"]) {
      draft = await manager.update(initial.automationId, draft.revision, {
        kind: "add_node", parentSequenceId: draft.definition.body.id,
        index: draft.definition.body.children.length, nodeWithoutId: tool(title),
      });
    }
    const ids = draft.definition.body.children.map((node) => node.id);
    draft = await manager.update(initial.automationId, draft.revision, {
      kind: "wrap_parallel", nodeIds: ids.slice(0, 2),
    });
    const graph = compileAutomationGraph(draft.definition);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.graph.steps.find((step) => step.id === ids[2])?.dependsOn).toEqual(ids.slice(0, 2));
  });

  it("clears an old payload when a Tool step changes to an operation without one", async () => {
    const manager = createAutomationDraftManager({ persistence: createTestPersistence() });
    const initial = await manager.create("Tool operation change");
    const added = await manager.update(initial.automationId, initial.revision, {
      kind: "add_node", parentSequenceId: initial.definition.body.id, index: 0,
      nodeWithoutId: {
        ...tool("Create document"), payload: { kind: "literal", value: "old body" },
      },
    });
    const node = added.definition.body.children[0]!;
    const updated = await manager.update(initial.automationId, added.revision, {
      kind: "update_node", nodeId: node.id,
      patch: {
        operation: { toolName: "example", operationId: "read", contractVersion: 1 },
        payload: null,
      },
    });
    expect(updated.definition.body.children[0]).not.toHaveProperty("payload");
  });

  it("rejects malformed model output schemas before the graph walker reads properties", async () => {
    const manager = createAutomationDraftManager({ persistence: createTestPersistence() });
    const draft = await manager.create("Agent intake");
    await expect(manager.update(draft.automationId, 1, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
      nodeWithoutId: {
        kind: "agent", title: "Extract", onFailure: "stop", modelProfileId: "model",
        agentMode: "fast", roleInstructions: "", prompt: "Extract", inputs: {}, tools: [],
        result: { kind: "json", schema: { type: "object" } },
      },
    })).rejects.toThrow("automation_graph_invalid");
  });
});
