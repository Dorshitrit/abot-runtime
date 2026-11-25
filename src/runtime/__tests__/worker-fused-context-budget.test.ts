import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import { resolveModelContextBudget } from "../model/model-context-budget.js";
import type { ModelGatewayClient } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityAdapter } from "../orchestration/worker-capabilities/index.js";
import type { RequestCapabilityExecutionView } from "../request/execution-scope.js";
import { GENERIC_WORKER_EXECUTOR } from "../steps/worker-decision/run.js";
import { projectWorkerFusedOutputContract, WORKER_OUTPUT_TYPE_NOTATION } from "../steps/worker-decision/fused-output-contract.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createWorkerDecisionModelPolicy, createWorkerDecisionRunnerConfig } from "./support/worker-decision-model-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([
  { contextWindowTokens: 10_000, needsRepair: false, includePathCapability: true },
  { contextWindowTokens: 10_000, needsRepair: true, includePathCapability: true },
  { contextWindowTokens: 8_000, needsRepair: false, includePathCapability: false },
])("admits non-path selection at $contextWindowTokens with repair=$needsRepair without compaction or controls", async ({ contextWindowTokens, needsRepair, includePathCapability }) => {
  const ledger = createRoleCallLedger({ requestId: "worker-request", policy: { limits: {
    maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
    maxObjectiveChars: 16_000, maxResultChars: 64_000, maxResponseChars: 64_000,
  } } });
  for (const command of [
    { authority: "runtime", type: "create_root" },
    { authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker",
      objective: "Explain why small checkpoints reduce implementation risk." },
  ]) {
    const committed = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!committed.ok) throw new Error(committed.code);
  }
  const call = ledger.current().state.calls.find(({ callId }) => callId === "call-2")!;
  const intent = "Look up the requested release summary.";
  const controls = Object.freeze({ query: "runtime release summary" });
  const pathExecute = vi.fn<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]>();
  const queryExecute = vi.fn<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]>(async () => ({
    outcome: "succeeded", observedEffect: "observation", summary: "Found the requested release summary.",
  }));
  const adapters: readonly WorkerCapabilityAdapter<RequestCapabilityExecutionView>[] = [
    { descriptor: {
      capabilityId: "write_complete_file", summary: "Write one complete file.", effect: "mutation",
      controlsRefinement: "mechanical_when_complete", selectionControlIds: ["path"], runtimePathControlIds: ["path"],
      controls: { type: "object", additionalProperties: false,
        properties: { path: { type: "string", minLength: 1, maxLength: 4_096 } }, required: ["path"] },
    }, execute: pathExecute },
    { descriptor: {
      capabilityId: "lookup_release_summary", summary: "Look up one release summary.", effect: "observation",
      controlsRefinement: "mechanical_when_complete", selectionControlIds: ["query"],
      controls: { type: "object", additionalProperties: false,
        properties: { query: { type: "string", minLength: 1, maxLength: 4_096 } }, required: ["query"] },
    }, execute: queryExecute },
  ];
  const availableAdapters = includePathCapability ? adapters : [adapters[1]!];
  let originalContract: string | undefined;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(input.modelStep).toBe("worker.decision");
    expect(input.format).toMatchObject({ name: "worker_evidence_and_selection" });
    const messages = input.messages as readonly ChatMessage[];
    const contracts = messages.filter(({ content }) => content.includes(WORKER_OUTPUT_TYPE_NOTATION));
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.role).toBe("system");
    expect(messages[0]?.content).not.toContain(WORKER_OUTPUT_TYPE_NOTATION);
    if (originalContract === undefined) {
      originalContract = contracts[0]!.content;
      expect(messages.at(-1)).toBe(contracts[0]);
    }
    expect(contracts[0]!.content).toBe(originalContract);
    expect(contracts[0]!.content).toContain('selectionControls:');
    expect(contracts[0]!.content).toContain('"lookup_release_summary"');
    expect(contracts[0]!.content).toContain('evidenceRefs:[]');
    expect(messages.slice(1, messages.indexOf(contracts[0]!)).some(({ content }) =>
      content.includes('"kind":"runtime_worker_evidence_assignment_v1"'))).toBe(true);
    if (includePathCapability) expect(JSON.stringify(input.messages)).toContain('news/news.txt');
    if (needsRepair && invoke.mock.calls.length === 1) return { text: JSON.stringify({ decision: {
      action: "invoke_capability", capabilityId: "lookup_release_summary", intent, selectionControls: controls,
    } }), meta: {} };
    return { text: JSON.stringify({ decision: {
      assessment: { requiresExecution: true, established: "No observation yet.",
        remaining: "Look up the requested release summary.", evidenceRefs: [] },
      selection: { action: "invoke_capability", capabilityId: "lookup_release_summary", intent, selectionControls: controls },
    } }), meta: {} };
  });
  const onEvent = vi.fn();
  const request = createTestRequestExecutionScope({
    requestId: "worker-request", sessionId: "worker-session",
    prompt: "Write EXACT_WORKER_LITERAL to /tmp/worker target.txt.",
    historyMessages: [{ id: "history-secret", role: "user", content: "HISTORY_MUST_NOT_REACH_WORKER", createdAt: "2026-07-25T00:00:00.000Z" }],
    shouldGenerateSessionTitle: false, runnerConfig: createWorkerDecisionRunnerConfig(),
    modelPolicy: createWorkerDecisionModelPolicy(contextWindowTokens), agentMode: "reasoning",
    attachments: [{ id: "attachment-secret", kind: "image", name: "ATTACHMENT_MUST_NOT_REACH_WORKER",
      mimeType: "image/png", storageRef: "attachments/ATTACHMENT_CONTENT_MUST_NOT_REACH_WORKER", data: "ATTACHMENT_CONTENT_MUST_NOT_REACH_WORKER" }],
    sessionArtifactPaths: Object.freeze(["news/news.txt"]),
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => availableAdapters.map(({ descriptor }) => descriptor),
      getAdapters: () => availableAdapters, getExecutionGuidance: async () => "" },
    toolPermissionMode: "full_access", abortSignal: new AbortController().signal, onEvent,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(),
  });
  const result = await GENERIC_WORKER_EXECUTOR.execute({ context: request, call, ledger, availableChildRoleIds: [] })
    .catch((error: unknown) => error);
  const snapshots = onEvent.mock.calls.filter(([name]) => name === "context.window.snapshot").map(([, detail]) => detail);
  const diagnostics = { invocations: invoke.mock.calls.length, snapshots,
    compaction: onEvent.mock.calls.filter(([name]) => String(name).startsWith("context.compaction.")) };
  expect(result, JSON.stringify(diagnostics)).toMatchObject({ kind: "continue", continuation: { kind: "capability_execution" } });
  expect(invoke).toHaveBeenCalledTimes(needsRepair ? 2 : 1);
  expect(queryExecute).toHaveBeenCalledOnce();
  expect(pathExecute).not.toHaveBeenCalled();
  expect(onEvent.mock.calls.some(([name]) => name === "context.compaction.started")).toBe(false);
  expect(snapshots).toEqual(expect.arrayContaining([expect.objectContaining({
    modelStep: "worker.decision", contextWindowTokens, compactionRequired: false,
  })]));
  if (contextWindowTokens === 8_000) {
    const invocation = invoke.mock.calls[0]![0];
    const messages = invocation.messages as readonly ChatMessage[];
    const format = invocation.format as ModelGatewayJsonSchemaFormat;
    const contract = messages.at(-1)!;
    if (contract.role !== "system") throw new Error("Worker trailing output contract missing");
    expect(contract.content).toContain(WORKER_OUTPUT_TYPE_NOTATION);
    const fullSchemaMessages = [...messages.slice(0, -1), { ...contract, content: JSON.stringify(format.schema) }];
    const budget = resolveModelContextBudget({ runnerConfig: request.runnerConfig, agentMode: request.agentMode,
      modelStep: "worker.decision", modelPolicy: request.modelPolicy });
    const before = assessRequestMessagesBudget({ messages: fullSchemaMessages, format, budget }).budget;
    const after = assessRequestMessagesBudget({ messages, format, budget }).budget;
    expect(before.estimatedInputTokens).toBeGreaterThanOrEqual(before.compactionTriggerInputTokens);
    expect(after.estimatedInputTokens).toBeLessThan(after.compactionTriggerInputTokens);
  }
});

test("the compact guide preserves selection field names, enum literals, bounds and nullable optional controls", () => {
  const format = { type: "json_schema" as const, name: "selection_contract", schema: {
    properties: { decision: { type: "object", additionalProperties: false,
      required: ["action", "capabilityId", "selectionControls"], properties: {
        action: { type: "string", enum: ["invoke_capability"] },
        capabilityId: { type: "string", enum: ["example.observe"] },
        selectionControls: { type: "object", additionalProperties: false,
          required: ["mode", "target"], properties: {
            mode: { type: "string", enum: ["read", "check"] },
            target: { anyOf: [{ type: "string", minLength: 1, maxLength: 64 }, { type: "null" }] },
          } },
      } } },
  } };
  const original = structuredClone(format);
  const guide = projectWorkerFusedOutputContract(format, ["execution-1"]);
  expect(guide).toContain('mode:("read"|"check")');
  expect(guide).toContain('target:(string[1..64]|null)');
  expect(guide).toContain('evidenceRefs:Array<"execution-1">[0..1] unique');
  expect(guide).toContain('selectionControls:');
  expect(guide).toContain('action:"invoke_capability"');
  expect(format).toEqual(original);
});
