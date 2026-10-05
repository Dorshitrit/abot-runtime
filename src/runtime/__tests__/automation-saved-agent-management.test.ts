import { describe, expect, it } from "vitest";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { createAutomationSavedAgentManager } from "../automations/saved-agent-management.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";

function persistence(): AutomationPersistence {
  let state = emptyAutomationJournalState();
  return {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const next = structuredClone(state);
      const result = mutate(next);
      state = next;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
}

describe("saved automation agent revisions", () => {
  it("copies a draft agent's reusable configuration without run inputs or grants", async () => {
    const store = persistence();
    const drafts = createAutomationDraftManager({ persistence: store });
    const agents = createAutomationSavedAgentManager({ persistence: store, now: () => 1_000 });
    const initial = await drafts.create("Intake");
    const draft = await drafts.update(initial.automationId, initial.revision, {
      kind: "add_node", parentSequenceId: initial.definition.body.id, index: 0,
      nodeWithoutId: {
        kind: "agent", title: "Extract", onFailure: "stop", modelProfileId: "local",
        agentMode: "fast", roleInstructions: "Extract fields", prompt: "Read this input",
        inputs: { privateData: { kind: "literal", value: "do-not-copy" } },
        tools: [{ operation: { toolName: "files", operationId: "read", contractVersion: 1 }, usage: "available" }],
        result: { kind: "text" },
      },
    });
    const nodeId = draft.definition.body.children[0]!.id;
    const first = await agents.saveFromDraft({
      automationId: draft.automationId, nodeId, expectedDraftRevision: draft.revision,
    });
    expect(first.agent.id).not.toBe(nodeId);
    expect(first.agent.inputs).toEqual({});
    expect(first.agent.prompt).toBe("Read this input");
    expect(first.agent.tools).toHaveLength(1);
    expect(first.agent).not.toHaveProperty("savedAgentOrigin");
    expect(JSON.stringify(first)).not.toContain("do-not-copy");
    expect((await store.read()).grants).toEqual([]);

    const next = await agents.saveFromDraft({
      automationId: draft.automationId, nodeId, expectedDraftRevision: draft.revision,
      agentId: first.agentId, expectedAgentRevision: 1,
    });
    expect(next.revision).toBe(2);
    expect((await agents.get(first.agentId, 1))?.revision).toBe(1);
    expect((await agents.list()).map((agent) => agent.revision)).toEqual([2]);
    await expect(agents.saveFromDraft({
      automationId: draft.automationId, nodeId, expectedDraftRevision: draft.revision,
      agentId: first.agentId, expectedAgentRevision: 1,
    })).rejects.toThrow("automation_revision_conflict");
  });

  it("rejects a stale draft or non-agent node without persisting a template", async () => {
    const store = persistence();
    const drafts = createAutomationDraftManager({ persistence: store });
    const agents = createAutomationSavedAgentManager({ persistence: store });
    const draft = await drafts.create("Intake");
    await expect(agents.saveFromDraft({
      automationId: draft.automationId, nodeId: draft.definition.body.id,
      expectedDraftRevision: draft.revision,
    })).rejects.toThrow("automation_dependency_missing");
    await expect(agents.saveFromDraft({
      automationId: draft.automationId, nodeId: "missing", expectedDraftRevision: 999,
    })).rejects.toThrow("automation_revision_conflict");
    expect(await agents.list()).toEqual([]);
  });
});
