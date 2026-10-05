import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationService } from "../automations/service.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/index.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const requestId = "automation-authoring-selection";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function fixture() {
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
  const draft = await drafts.create("Selection test");
  const service = {
    create: drafts.create, getDraft: drafts.get, updateDraft: drafts.update,
    catalog: async () => ({ operations: [], grantableOperations: [], models: [], savedAgents: [], templates: [] }),
  } as unknown as AutomationService;
  const module = createAutomationDraftToolModule(() => service, async () => undefined);
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const provider = createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => registry, requestId, sessionId: "selection-session",
    abortSignal: new AbortController().signal, toolPermissionMode: "full_access",
    nextApprovalId: () => "unexpected-approval",
  });
  const invoke = vi.fn(async () => { throw new Error("unexpected_controls_model_call"); });
  const request = createTestRequestExecutionScope({
    requestId, sessionId: "selection-session", prompt: "Inspect the selected draft.",
    historyMessages: [], shouldGenerateSessionTitle: false,
    runnerConfig: { models: { defaults: { profileId: "test", steps: {} } }, steps: {},
      context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 100 } },
    agentMode: "fast", modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: provider, toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  const ledger = createRoleCallLedger({ requestId, policy: {
    authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
    limits: { maxDepth: 4, maxCalls: 12, maxCapabilityExecutions: 24,
      maxObjectiveChars: 4_096, maxResultChars: 8_192, maxResponseChars: 8_192 },
  } });
  const root = await ledger.apply({ expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" } });
  if (!root.ok) throw new Error(root.code);
  const head = ledger.current();
  const call = head.state.calls.find((entry) => entry.callId === head.state.activeCallId)!;
  const capabilities = provider.getDescriptors();
  const options = { capabilities, maxBatchCapabilityExecutions: 8 };
  const parse = (decision: unknown) => parseExecutionAgentDecisionOutput(
    JSON.stringify({ decision }), options,
  );
  const refine = async (capabilityId: string, selectionControls: Record<string, unknown>) => {
    const parsed = parse({ action: "invoke_capability", capabilityId,
      intent: "Use the selected draft.", selectionControls });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.action !== "invoke_capability")
      throw new Error("expected_authoring_invocation");
    return refineExecutionCapabilityInvocations(request, {
      head, call, capabilities, eligibleSessionArtifactPaths: [],
      invocations: [parsed.decision],
      steeringSnapshot: createRequestSteeringInbox({ requestId }).snapshot(),
    });
  };
  return { draft, drafts, registry, provider, invoke, parse, refine, call };
}

describe("automation authoring mechanical selection controls", () => {
  it.each(["read_draft", "validate_draft"])(
    "%s preserves the selected automation without a controls model round", async (operation) => {
      const f = await fixture();
      const controls = { automationId: f.draft.automationId };
      const result = await f.refine(operation, controls);
      expect(result.invocations).toHaveLength(1);
      expect(result.invocations[0]?.controls).toEqual(controls);
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );

  it("discovers the global catalog without creating a draft or refining controls", async () => {
    const f = await fixture();
    const execute = vi.spyOn(f.registry, "execute");
    const selected = await f.refine("browse_catalog", { offset: 0 });
    const adapter = f.provider.getAdapters().find(({ descriptor }) => descriptor.capabilityId === "browse_catalog")!;
    const result = await adapter.execute({ context: {}, call: f.call,
      executionId: "capability-execution-1", intent: "Inspect available workflow operations.",
      controls: selected.invocations[0]!.controls, settledCapabilityResults: [] });
    expect(result.outcome).toBe("succeeded");
    expect(execute).toHaveBeenCalledWith({ tool: "automations", params: {
      action: "browse_catalog", view: "index", offset: 0,
    } }, expect.any(Object));
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("reads the exact draft through the registered tool after selection", async () => {
    const f = await fixture();
    const other = await f.drafts.create("Unrelated draft");
    const result = await f.refine("read_draft", { automationId: other.automationId });
    const execution = await f.registry.execute({ tool: "automations",
      params: { action: "read_draft", ...result.invocations[0]!.controls } });
    expect(execution.ok).toBe(true);
    expect(JSON.parse(execution.output).draft.automationId).toBe(other.automationId);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("retains the exact revision and rejects a stale trigger mutation", async () => {
    const f = await fixture();
    const controls = { automationId: f.draft.automationId, expectedRevision: f.draft.revision };
    const newer = await f.drafts.update(f.draft.automationId, f.draft.revision, {
      kind: "update_definition", patch: { title: "Newer user edit" },
    });
    const stale = await f.registry.execute({ tool: "automations",
      params: { action: "set_trigger_manual", ...controls } });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("automation_revision_conflict");
    expect((await f.drafts.get(f.draft.automationId))?.revision).toBe(newer.revision);
    expect((await f.drafts.get(f.draft.automationId))?.definition.title).toBe("Newer user edit");
    const current = { automationId: f.draft.automationId, expectedRevision: newer.revision };
    const saved = await f.registry.execute({ tool: "automations",
      params: { action: "set_trigger_manual", ...current } });
    expect(saved.ok).toBe(true);
    expect(JSON.parse(saved.output).revision).toBe(newer.revision + 1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["read_draft", {}], ["read_draft", { automationId: "" }],
    ["prepare_draft", {}], ["prepare_draft", { operationRefs: "invalid" }],
    ["list_drafts", { offset: -1 }],
  ])("rejects incomplete or invalid %s selection before execution", async (capabilityId, selectionControls) => {
    const f = await fixture();
    expect(f.parse({ action: "invoke_capability", capabilityId,
      intent: "Use the selected draft.", selectionControls }).ok).toBe(false);
    expect((await f.drafts.get(f.draft.automationId))?.revision).toBe(1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("offers only the focused authoring surface and rejects granular model mutations", async () => {
    const f = await fixture();
    const selected = f.provider.getDescriptors();
    expect(selected.map((item) => item.capabilityId).sort()).toEqual([
      "add_saved_agent", "browse_catalog", "list_drafts", "prepare_draft",
      "read_draft", "save_agent", "validate_draft",
    ]);
    for (const operation of selected) expect(operation.selectionControlIds?.length).toBeGreaterThan(0);
    for (const capabilityId of ["create_draft", "add_agent", "add_tool", "set_details", "bind_step_result"])
      expect(f.parse({ action: "invoke_capability", capabilityId, intent: "Edit the draft.",
        operationObjective: "Configure a step." }).ok).toBe(false);
    const preparation = await f.refine("prepare_draft", { operationRefs: [] });
    expect(preparation.invocations[0]?.controls).toEqual({ operationRefs: [] });
    const list = await f.refine("list_drafts", { offset: 0 });
    expect(list.invocations[0]?.controls).toEqual({ offset: 0 });
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
