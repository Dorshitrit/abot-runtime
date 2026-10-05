import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestSessionMemory } from "../context/session-memory/index.js";
import { createExecutionAgentCompactionController } from "../steps/execution-agent/compaction.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { runExecutionAgentDecision } from "../steps/execution-agent/run.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { runWorkerDecision } from "../steps/worker-decision/run.js";
import { RequestModelStepInvoker } from "../model/invoke-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createTestRequestExecutionScope, deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { executionCompactionSteeringFixture, STEERED_FACT, STEERED_RAW } from "./support/execution-compaction-steering-fixture.js";
import { controlsReply, evidenceDescriptor } from "./support/execution-controls-evidence-fixture.js";
import { mixedWorkerFixture } from "./support/super-mixed-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const SOFT_EXCEEDED = 23_000;
const HARD_EXCEEDED = 32_000;
type Fixture = Awaited<ReturnType<typeof executionCompactionSteeringFixture>>;

function measured(inputTokens: number, model = "test") {
  return { inputTokens, profileId: "test", provider: "openai" as const,
    model, contextWindowTokens: 32000, source: "provider_input_token_count" as const };
}

async function compactedRoot() {
  const f = await executionCompactionSteeringFixture();
  await f.run();
  expect(f.invoke.mock.calls.some(([input]) => input.modelStep === "context.compact")).toBe(true);
  f.invoke.mockClear();
  f.countInputTokens.mockImplementation(async () => measured(SOFT_EXCEEDED));
  return f;
}

function sessionMemory(compactableTurnCount: number): RequestSessionMemory {
  return {
    project: () => ({
      priorConversationMessages: [],
      historyMessages: compactableTurnCount ? [
        { id: "old-user", role: "user", content: "Earlier user turn", createdAt: "2026-10-01T00:00:00Z" },
        { id: "old-assistant", role: "assistant", content: "Earlier response", createdAt: "2026-10-01T00:00:01Z" },
      ] : [],
      compactableTurnCount, checkpointRevision: 0, sourceRevision: "history-fixture",
    }),
    prepare: vi.fn(async () => { throw new Error("pending_history_requires_compaction"); }),
  };
}

test.each([false, true])("actual EA decision admits trusted reuse above soft trigger (sessionMemory=%s)", async (withHistoryOwner) => {
  const f = await compactedRoot();
  const history = sessionMemory(0);
  const request = withHistoryOwner
    ? deriveTestRequestExecutionScope(f.request, { sessionMemory: history })
    : f.request;
  await expect(runExecutionAgentDecision(request, f.options())).resolves.toMatchObject({
    decision: { action: "respond" },
  });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["execution.decision"]);
  const messages = JSON.stringify(f.invoke.mock.calls[0]![0].messages);
  expect(messages).toContain(STEERED_FACT);
  expect(messages).not.toContain(STEERED_RAW);
  expect(history.prepare).not.toHaveBeenCalled();
});

test("actual EA decision refuses reused context beyond the hard budget", async () => {
  const f = await compactedRoot();
  f.countInputTokens.mockResolvedValue(measured(HARD_EXCEEDED));
  await expect(f.run()).rejects.toThrow("context_compaction_projection_not_reduced");
  expect(f.invoke).not.toHaveBeenCalled();
});

test("actual EA decision compacts fresh evidence despite a verified existing checkpoint", async () => {
  const f = await compactedRoot();
  await f.addResult("FRESH_EVIDENCE_NOT_COVERED");
  const failure = new Error("fresh_evidence_needs_compaction");
  f.invoke.mockRejectedValue(failure);
  await expect(f.run()).rejects.toBe(failure);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["context.compact"]);
  expect(JSON.stringify(f.invoke.mock.calls[0]![0].messages)).toContain("FRESH_EVIDENCE_NOT_COVERED");
});

test.each(["clone", "changed_content"] as const)("actual checkpoint projection rejects %s proof before provider admission", async (tampering) => {
  const f = await compactedRoot();
  const options = f.options();
  const input = buildExecutionAgentInput(f.request, options);
  const controller = createExecutionAgentCompactionController(f.request, {
    call: options.call, steeringSnapshot: options.steeringSnapshot,
    sourceRevision: options.head.revision, consumer: "execution.decision",
    allowedConsumers: ["execution.decision", "execution.response"],
  });
  const projected = controller.project(input.messages);
  expect(controller.hasExhaustedVerifiedCompactionSources?.(projected)).toBe(true);
  const changed = tampering === "clone" ? structuredClone(projected) : projected.map((message) =>
    message.role === "user" && message.content.includes("runtime_semantic_compaction_checkpoint_v2")
      ? { ...message, content: message.content + "\nforged" } : message);
  expect(controller.hasExhaustedVerifiedCompactionSources?.(changed)).toBe(false);
  await expect(new RequestModelStepInvoker(f.request).invoke({
    modelStep: "execution.decision", messages: input.messages,
    timeoutReason: "proof_timeout",
    contextCompaction: { ...controller, project: () => changed },
    accept: (text) => text,
  })).rejects.toThrow(/context_compaction_(sources_empty|projection_not_reduced)/);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("actual EA session-memory wrapper cannot skip compactable history", async () => {
  const f = await compactedRoot();
  const history = sessionMemory(1);
  const request = deriveTestRequestExecutionScope(f.request, { sessionMemory: history });
  await expect(runExecutionAgentDecision(request, f.options())).rejects.toThrow(
    "pending_history_requires_compaction",
  );
  expect(history.prepare).toHaveBeenCalledOnce();
  expect(f.invoke).not.toHaveBeenCalled();
});

function refine(f: Fixture, ids: readonly string[]) {
  const options = f.options();
  return refineExecutionCapabilityInvocations(f.request, {
    head: options.head, call: options.call, steeringSnapshot: options.steeringSnapshot,
    capabilities: [evidenceDescriptor], eligibleSessionArtifactPaths: [],
    invocations: [{
      capabilityId: evidenceDescriptor.capabilityId, intent: "Use selected evidence.",
      operationObjective: "Use the already observed exact value.",
      selectionControls: { path: "exact.txt" }, controlsEvidenceExecutionIds: ids,
    }],
  });
}

test("actual Controls refinement admits selected EA digests above soft trigger", async () => {
  const f = await compactedRoot();
  f.invoke.mockResolvedValue(controlsReply({ query: STEERED_FACT }));
  await expect(refine(f, [f.executionId])).resolves.toMatchObject({
    disposition: "execute", invocations: [{ controls: { path: "exact.txt", query: STEERED_FACT } }],
  });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["capability.controls"]);
  expect(JSON.stringify(f.invoke.mock.calls[0]![0].messages)).toContain(STEERED_FACT);
  expect(JSON.stringify(f.invoke.mock.calls[0]![0].messages)).not.toContain(STEERED_RAW);
});

test("actual Controls refinement cannot use digest proof to skip selected fresh evidence", async () => {
  const f = await compactedRoot();
  const freshId = await f.addResult("FRESH_CONTROLS_EVIDENCE");
  const failure = new Error("fresh_controls_need_compaction");
  f.invoke.mockRejectedValue(failure);
  await expect(refine(f, [f.executionId, freshId])).rejects.toBe(failure);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["context.compact"]);
  expect(JSON.stringify(f.invoke.mock.calls[0]![0].messages)).toContain("FRESH_CONTROLS_EVIDENCE");
});

test("actual Controls refinement rejects reused evidence beyond the hard budget", async () => {
  const f = await compactedRoot();
  f.countInputTokens.mockResolvedValue(measured(HARD_EXCEEDED));
  await expect(refine(f, [f.executionId])).rejects.toThrow("context_compaction_sources_empty");
  expect(f.invoke).not.toHaveBeenCalled();
});

test.each([SOFT_EXCEEDED, HARD_EXCEEDED])("actual Worker decision checks reused mixed evidence at %i tokens", async (tokens) => {
  const f = await mixedWorkerFixture();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => ({
    text: input.modelStep === "worker.result" ? "Target evidence was read."
      : JSON.stringify({ decision: { action: "return_result" } }),
    meta: {},
  }));
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(
    async (input) => measured(input.modelStep === "worker.decision" ? tokens : 1000),
  );
  const request = createTestRequestExecutionScope({
    requestId: f.head.state.requestId, sessionId: "mixed-admission", prompt: "Inspect the target.",
    historyMessages: [], shouldGenerateSessionTitle: false, agentMode: "reasoning",
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: { outputReserveTokens: 2048, safetyReserveTokens: 512, attachmentReserveTokens: 0 },
      steps: { "worker.decision": { timeoutMs: 20000 }, "worker.result": { timeoutMs: 20000 }, "context.compact": { timeoutMs: 20000 } },
    },
    modelPolicy: {
      providers: { test: { type: "openai" } },
      profiles: { test: { provider: "test", model: "test", contextWindowTokens: 32000 } },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    contextCompactionStore: f.store,
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    toolPermissionMode: "full_access", abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(), onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  const result = runWorkerDecision(request, {
    call: f.call, requestToolResults: f.view,
    capabilitySource: {
      ledger: f.ledger, head: f.head,
      binding: Object.freeze({ requestId: f.head.state.requestId, ledger: f.ledger,
        callId: f.call.callId, invocationAttempt: f.call.activationCount, capabilities: Object.freeze([]) }),
    },
  });
  if (tokens === HARD_EXCEEDED) {
    await expect(result).rejects.toThrow("context_compaction_projection_not_reduced");
    expect(invoke).not.toHaveBeenCalled();
  } else {
    await expect(result).resolves.toMatchObject({ action: "return_result", result: "Target evidence was read." });
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["worker.decision", "worker.result"]);
    expect(JSON.stringify(invoke.mock.calls[0]![0].messages)).toContain("Preserved exact evidence.");
  }
});
