import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/index.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const requestId = "payload-operation-selection";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function capability(id: string, payload: boolean, selected = true): CapabilityDescriptor {
  return { capabilityId: id, summary: "Process one bounded input.", effect: "observation",
    controls: { type: "object", additionalProperties: false,
      properties: { target: { type: "string", minLength: 1, maxLength: 200 } }, required: ["target"] },
    ...(selected ? { selectionControlIds: ["target"] } : {}),
    ...(payload ? { requiresPayloadAuthoringObjective: true } : {}) };
}

async function fixture(capabilities: readonly CapabilityDescriptor[]) {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const assignment = (input.messages as readonly ChatMessage[]).map(({ content }) => {
      try { return JSON.parse(content); } catch { return undefined; }
    }).find((value) => value?.kind === "runtime_execution_capability_refinement_v1");
    expect(assignment).toBeDefined();
    return { text: JSON.stringify({ decision: { invocations: Object.fromEntries(
      assignment.invocations.map((entry: { slot: string; operationObjective: string }) => {
        expect(entry.operationObjective).toBe("Read the selected document.");
        return [entry.slot, { disposition: "execute", controls: { target: "document.txt" } }];
      }),
    ) } }), meta: {} };
  });
  const provider = { getDescriptors: () => capabilities, getAdapters: () => [] };
  const request = createTestRequestExecutionScope({
    requestId, sessionId: "payload-selection-session", prompt: "Process the selected inputs.",
    historyMessages: [], shouldGenerateSessionTitle: false,
    runnerConfig: { models: { defaults: { profileId: "test", steps: {} } },
      steps: { "capability.controls": { timeoutMs: 20_000 } },
      context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 100 } },
    agentMode: "fast", modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    modelPolicy: { providers: { local: { type: "ollama" } },
      profiles: { test: { provider: "local", model: "test", contextWindowTokens: 32_000 } },
      defaults: { profileId: "test", steps: {} } },
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
  const created = await ledger.apply({ expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" } });
  if (!created.ok) throw new Error(created.code);
  const head = ledger.current();
  const call = head.state.calls.find((entry) => entry.callId === head.state.activeCallId)!;
  const parse = (decision: unknown) => parseExecutionAgentDecisionOutput(
    JSON.stringify({ decision }), { capabilities, maxBatchCapabilityExecutions: 8 },
  );
  const refine = async (decision: unknown) => {
    const parsed = parse(decision);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    if (parsed.decision.action !== "invoke_capability" && parsed.decision.action !== "invoke_capabilities")
      throw new Error("expected_capability_selection");
    return refineExecutionCapabilityInvocations(request, { head, call, capabilities,
      eligibleSessionArtifactPaths: [],
      invocations: parsed.decision.action === "invoke_capability" ? [parsed.decision] : parsed.decision.invocations,
      steeringSnapshot: createRequestSteeringInbox({ requestId }).snapshot() });
  };
  return { invoke, parse, refine };
}

describe("Execution Agent payload operation assignment", () => {
  it("requires a bounded payload assignment even when all controls are selected", async () => {
    const f = await fixture([capability("payload", true), capability("read", false)]);
    const selection = { action: "invoke_capability", capabilityId: "payload",
      intent: "Show this status only.", selectionControls: { target: "a.txt" } };
    expect(f.parse(selection).ok).toBe(false);
    expect(f.parse({ ...selection, operationObjective: " " }).ok).toBe(false);
    expect(f.parse({ ...selection, capabilityId: "read" }).ok).toBe(true);
    const first = await f.refine({ ...selection, operationObjective: "Extract only totals from a.txt." });
    const second = await f.refine({ ...selection, intent: "A different presentation.",
      operationObjective: "Extract only totals from a.txt." });
    expect(first.invocations[0]).toMatchObject({ authoringObjective: "Extract only totals from a.txt.",
      controls: { target: "a.txt" } });
    expect(second.invocations[0]?.authoringObjective).toBe(first.invocations[0]?.authoringObjective);
    expect(first.invocations[0]).not.toHaveProperty("operationObjective");
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("keeps each payload assignment with its exact batch slot", async () => {
    const f = await fixture([capability("payload", true)]);
    const result = await f.refine({ action: "invoke_capabilities", invocations: [
      { capabilityId: "payload", intent: "First status.", operationObjective: "Extract totals from a.txt.",
        selectionControls: { target: "a.txt" } },
      { capabilityId: "payload", intent: "Second status.", operationObjective: "Extract names from b.txt.",
        selectionControls: { target: "b.txt" } },
    ] });
    expect(result.invocations.map(({ authoringObjective, controls }) => ({ authoringObjective, controls }))).toEqual([
      { authoringObjective: "Extract totals from a.txt.", controls: { target: "a.txt" } },
      { authoringObjective: "Extract names from b.txt.", controls: { target: "b.txt" } },
    ]);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("selects ordinary observation controls without a second authoring step", async () => {
    const f = await fixture([capability("selected", false, false)]);
    const result = await f.refine({
      action: "invoke_capability",
      capabilityId: "selected",
      intent: "Read the selected document.",
      selectionControls: { target: "document.txt" },
    });
    expect(result.invocations[0]?.controls).toEqual({ target: "document.txt" });
    expect(result.invocations[0]).not.toHaveProperty("authoringObjective");
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("refines payload controls and forwards the bounded authoring objective", async () => {
    const f = await fixture([capability("selected", true, false)]);
    const result = await f.refine({
      action: "invoke_capability",
      capabilityId: "selected",
      intent: "Display progress.",
      operationObjective: "Read the selected document.",
      controlsEvidenceExecutionIds: [],
    });
    expect(result.invocations[0]?.controls).toEqual({ target: "document.txt" });
    expect(result.invocations[0]?.authoringObjective).toBe(
      "Read the selected document.",
    );
    expect(f.invoke).toHaveBeenCalledOnce();
  });

  it("authors a no-control payload without inserting a controls model call", async () => {
    const descriptor = { ...capability("payload", true), selectionControlIds: [],
      controls: { type: "object" as const, additionalProperties: false as const, properties: {}, required: [] } };
    const f = await fixture([descriptor]);
    const result = await f.refine({ action: "invoke_capability", capabilityId: "payload",
      intent: "Display progress.", operationObjective: "Prepare the exact requested content." });
    expect(result.invocations[0]).toMatchObject({ controls: {}, authoringObjective: "Prepare the exact requested content." });
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
