import { describe, expect, it, vi } from "vitest";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { createAutomationSavedAgentManager } from "../automations/saved-agent-management.js";
import { findAutomationStep } from "../automations/step-evidence-effects.js";
import type { AutomationService } from "../automations/service.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { createDefaultToolRegistry } from "../default-environment-adapters.js";
import type { RuntimeConfig } from "../ports.js";

const runtimeConfig: RuntimeConfig = {
  runtimeId: "test", agentBridgeUrl: "ws://test", modelGatewayUrl: "http://test",
  requestRunner: { configPath: "/unused/runner.json" },
  plugins: { enabled: false },
  paths: {
    rootDir: "/unused", runtimeDir: "/unused/runtime", agentWorkDir: "/unused/work",
    sessionsDir: "/unused/sessions", attachmentsDir: "/unused/attachments",
    workspaceDir: "/unused/workspace", sharedDir: "/unused/shared",
    compiledDir: "/unused/compiled", traceFile: "/unused/trace.jsonl",
  },
};

function fixture() {
  let state = emptyAutomationJournalState();
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const copy = structuredClone(state);
      const result = mutate(copy);
      state = copy;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
  const drafts = createAutomationDraftManager({ persistence });
  const saved = createAutomationSavedAgentManager({ persistence });
  const catalog = vi.fn(async () => ({ operations: [], grantableOperations: [
    { operationId: "private" },
  ], models: [{ id: "local", label: "Local" }], savedAgents: [] }));
  const service = {
    create: drafts.create,
    getDraft: drafts.get,
    updateDraft: drafts.update,
    validate: drafts.validate,
    catalog,
    getSavedAgent: saved.get,
    saveAgentFromDraft: saved.saveFromDraft,
  } as unknown as AutomationService;
  const ready = vi.fn(async () => undefined);
  const module = createAutomationDraftToolModule(() => service, ready);
  return { module, ready, catalog, service };
}

function output(result: Awaited<ReturnType<ReturnType<typeof createAutomationDraftToolModule>["implementation"]>>) {
  expect(result.ok).toBe(true);
  return JSON.parse(result.output) as Record<string, unknown>;
}

describe("automation draft model tool", () => {
  it("leaves registries without an automation service unchanged", () => {
    expect(createDefaultToolRegistry(runtimeConfig).listDefinitions().some((tool) =>
      tool.name === "automations")).toBe(false);
  });

  it("registers the complete native contract through the default runtime registry", () => {
    const { module } = fixture();
    const registry = createDefaultToolRegistry(runtimeConfig, undefined, {
      getService: () => ({} as AutomationService), ready: async () => undefined,
    });
    expect(registry.getDefinition("automations")?.name).toBe("automations");
    expect(registry.listNormalInvocations?.().find((entry) =>
      entry.toolName === "automations")?.contract.operations).toHaveLength(
        module.normalInvocation.operations.length,
      );
  });

  it("offers draft authoring but no grant, publish, run or activation authority", async () => {
    const { module, catalog } = fixture();
    const operations = module.normalInvocation.operations.map((item) => item.operationId);
    expect(operations).toContain("prepare_draft");
    expect(operations).toContain("add_saved_agent");
    expect(operations).not.toContain("add_agent");
    expect(operations).toContain("save_agent");
    expect(operations).not.toContain("publish");
    expect(operations).not.toContain("grant");
    expect(operations).not.toContain("run");
    const listed = output(await module.implementation({ action: "catalog", automationId: "exact" }));
    expect(listed).toMatchObject({
      kind: "automation_authoring_catalog_v1", grantsPermissions: false,
      operations: [{ operationId: "private" }], grantedOperations: [],
    });
    expect(listed).not.toHaveProperty("grantableOperations");
    expect(catalog).toHaveBeenCalledWith("exact");
  });

  it("builds a draft with generated IDs and CAS, then saves an agent revision", async () => {
    const { module, ready } = fixture();
    const created = output(await module.implementation({ action: "create_draft", title: "Invoices" }));
    const automationId = String(created.automationId);
    const added = output(await module.implementation({
      action: "add_agent", automationId, expectedRevision: 1,
      parentSequenceId: created.rootSequenceId, index: 0,
      title: "Extract", modelProfileId: "local", agentMode: "fast",
      roleInstructions: "Read invoice", prompt: "Extract supplier",
      onFailure: "stop",
    }));
    expect(added.revision).toBe(2);
    const nodeId = (added.newNodeIds as string[])[0]!;
    expect(nodeId).toMatch(/^n_/u);
    const edited = output(await module.implementation({
      action: "edit_agent", automationId, expectedRevision: 2, nodeId,
      prompt: "Extract supplier and total",
    }));
    expect(edited.revision).toBe(3);
    const stale = await module.implementation({
      action: "set_step_policy", automationId, expectedRevision: 2, nodeId,
      onFailure: "skip",
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("automation_revision_conflict");
    const saved = output(await module.implementation({
      action: "save_agent", automationId, expectedRevision: 3, nodeId,
    }));
    expect(saved.revision).toBe(1);
    const reused = output(await module.implementation({
      action: "add_saved_agent", automationId, expectedRevision: 3,
      parentSequenceId: created.rootSequenceId, index: 1,
      agentId: saved.agentId, agentRevision: 1,
    }));
    expect(reused.revision).toBe(4);
    expect((reused.newNodeIds as string[])).toHaveLength(1);
    expect(ready).toHaveBeenCalled();
  });

  it("updates agent model bindings without carrying an old reasoning override", async () => {
    const { module, service } = fixture();
    const created = output(await module.implementation({ action: "create_draft", title: "Think" }));
    const automationId = String(created.automationId);
    const added = output(await module.implementation({
      action: "add_agent", automationId, expectedRevision: 1,
      parentSequenceId: created.rootSequenceId, index: 0,
      title: "Answer", modelProfileId: "local", agentMode: "fast",
      roleInstructions: "Answer", prompt: "Think", onFailure: "stop",
      reasoningMode: "budget", reasoningBudgetTokens: 128,
    }));
    const nodeId = (added.newNodeIds as string[])[0]!;
    let revision = 2;
    const readAgent = async () => {
      const draft = await service.getDraft(automationId);
      const node = findAutomationStep(draft!.definition.body, nodeId);
      if (node?.kind !== "agent") throw new Error("agent_required");
      return node;
    };
    const edit = async (params: Record<string, unknown>) => {
      const result = await module.implementation({
        action: "edit_agent", automationId, expectedRevision: revision, nodeId, ...params,
      });
      if (result.ok) revision = Number(output(result).revision);
      return result;
    };
    const original = { profileId: "local", mode: "budget", budgetTokens: 128 };
    expect((await edit({ modelProfileId: "local" })).ok).toBe(true);
    expect((await readAgent()).reasoningPreference).toEqual(original);
    expect((await edit({ prompt: "New prompt" })).ok).toBe(true);
    expect((await readAgent()).reasoningPreference).toEqual(original);
    const rejected = await edit({ modelProfileId: "other", reasoningBudgetTokens: 64 });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("reasoningBudgetTokens requires reasoningMode=budget");
    expect((await readAgent()).reasoningPreference).toEqual(original);
    // Canonical draft mutations still require the caller to clear or replace a binding.
    await expect(service.updateDraft(automationId, revision, {
      kind: "update_node", nodeId, patch: { modelProfileId: "other" },
    })).rejects.toThrow();
    expect((await edit({ modelProfileId: "other" })).ok).toBe(true);
    expect(await readAgent()).toMatchObject({ modelProfileId: "other" });
    expect((await readAgent()).reasoningPreference).toBeUndefined();
    for (const reasoningMode of ["budget", "off", "server-default", "inherit"]) {
      const modelProfileId = reasoningMode;
      expect((await edit({
        modelProfileId, reasoningMode,
        ...(reasoningMode === "budget" ? { reasoningBudgetTokens: 64 } : {}),
      })).ok).toBe(true);
      const expected = reasoningMode === "inherit" ? undefined : {
        profileId: modelProfileId, mode: reasoningMode,
        ...(reasoningMode === "budget" ? { budgetTokens: 64 } : {}),
      };
      expect((await readAgent()).reasoningPreference).toEqual(expected);
    }
  });

  it("edits only reasoning controls while preserving the agent configuration", async () => {
    const { module, service } = fixture();
    const created = output(await module.implementation({ action: "create_draft", title: "Reasoning" }));
    const automationId = String(created.automationId);
    const added = output(await module.implementation({
      action: "add_agent", automationId, expectedRevision: 1,
      parentSequenceId: created.rootSequenceId, index: 0,
      title: "Answer", modelProfileId: "local", agentMode: "deep",
      roleInstructions: "Answer carefully", prompt: "Read the request", onFailure: "stop",
      reasoningMode: "budget", reasoningBudgetTokens: 128,
    }));
    const nodeId = (added.newNodeIds as string[])[0]!;
    let revision = Number(added.revision);
    const before = (await service.getDraft(automationId))!;
    const originalAgent = findAutomationStep(before.definition.body, nodeId);
    if (originalAgent?.kind !== "agent") throw new Error("agent_required");
    const { reasoningPreference: _original, ...unchangedAgent } = originalAgent;
    for (const reasoningMode of ["off", "budget", "server-default", "inherit"]) {
      const result = output(await module.implementation({
        action: "edit_agent", automationId, expectedRevision: revision, nodeId,
        reasoningMode, ...(reasoningMode === "budget" ? { reasoningBudgetTokens: 64 } : {}),
      }));
      revision += 1;
      expect(result.revision).toBe(revision);
      const draft = (await service.getDraft(automationId))!;
      const agent = findAutomationStep(draft.definition.body, nodeId);
      if (agent?.kind !== "agent") throw new Error("agent_required");
      const { reasoningPreference, ...preservedAgent } = agent;
      expect(preservedAgent).toEqual(unchangedAgent);
      expect(reasoningPreference).toEqual(reasoningMode === "inherit" ? undefined : {
        profileId: "local", mode: reasoningMode,
        ...(reasoningMode === "budget" ? { budgetTokens: 64 } : {}),
      });
    }
  });

  it.each([
    {}, { reasoningBudgetTokens: 64 }, { reasoningMode: "budget" },
    { reasoningMode: "budget", reasoningBudgetTokens: -1 },
    { reasoningMode: "off", reasoningBudgetTokens: 64 },
    { reasoningMode: "inherit", reasoningBudgetTokens: 64 },
    { reasoningMode: "effort" },
    { reasoningPreference: { profileId: "local", mode: "off" } },
  ])("rejects empty or malformed reasoning-only edits without mutating the draft: %j", async (controls) => {
    const { module, service } = fixture();
    const created = output(await module.implementation({ action: "create_draft", title: "Reasoning" }));
    const automationId = String(created.automationId);
    const added = output(await module.implementation({
      action: "add_agent", automationId, expectedRevision: 1,
      parentSequenceId: created.rootSequenceId, index: 0,
      title: "Answer", modelProfileId: "local", agentMode: "fast",
      roleInstructions: "Answer", prompt: "Think", onFailure: "stop",
      reasoningMode: "budget", reasoningBudgetTokens: 128,
    }));
    const before = await service.getDraft(automationId);
    const result = await module.implementation({
      action: "edit_agent", automationId, expectedRevision: added.revision,
      nodeId: (added.newNodeIds as string[])[0], ...controls,
    });
    expect(result.ok).toBe(false);
    expect(await service.getDraft(automationId)).toEqual(before);
  });

  it("rejects invalid bounded JSON without changing the draft", async () => {
    const { module } = fixture();
    const created = output(await module.implementation({ action: "create_draft", title: "Untitled" }));
    const failed = await module.implementation({
      action: "set_run_inputs", automationId: created.automationId,
      expectedRevision: 1, inputsJson: "not json",
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("automation_graph_invalid");
    const draft = output(await module.implementation({
      action: "read_draft", automationId: created.automationId,
    })).draft as { revision: number };
    expect(draft.revision).toBe(1);
  });
});
