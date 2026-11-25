import { createHash } from "node:crypto";
import type { ChatMessage } from "../../model-gateway/types.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { scheduleFinalResponseMemory } from "../long-term-memory/finalization.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { buildSupervisorMemoryConfiguredGuidance } from "../steps/supervisor-decision/memory-authoring-configuration.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  CHILD_FACT, createSupervisorMemoryFusionFixture, isAfterChildRouting, MEMORY_KNOWLEDGE,
  MEMORY_PROPOSAL, memoryFusionCapsules, memoryFusionFormat, RAW_ANSWER,
} from "./support/supervisor-memory-fusion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function afterChildCalls(f: ReturnType<typeof createSupervisorMemoryFusionFixture>) {
  const calls = f.invoke.mock.calls.map(([input]) => input);
  const start = calls.findIndex(isAfterChildRouting);
  expect(start).toBeGreaterThan(-1);
  return calls.slice(start);
}

test("after a real child return, one routing/memory JSON call and one RAW call finish the request", async () => {
  const f = createSupervisorMemoryFusionFixture();
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(RAW_ANSWER);
  const calls = afterChildCalls(f);
  expect(calls.map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
    "supervisor_decision_with_memory_candidates", "supervisor.response",
  ]);
  expect(calls[1]).not.toHaveProperty("format");
  expect(memoryFusionCapsules(calls[0]!, "runtime_child_result")).toMatchObject([{ summary: CHILD_FACT }]);
  expect(memoryFusionCapsules(calls[1]!, "runtime_child_result")).toMatchObject([{ summary: CHILD_FACT }]);
  expect(f.invoke.mock.calls.filter(([input]) => memoryFusionFormat(input) === "supervisor_memory_candidates")).toEqual([]);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "supervisor.decision", "supervisor.decision", "worker.decision", "worker.result",
    "supervisor.decision", "supervisor.response",
  ]);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(result.memoryCandidates).toMatchObject([{
    content: MEMORY_PROPOSAL.content, assessment: { target: MEMORY_KNOWLEDGE.entries[0], evidence: {
      sourceRequestId: f.request.requestId, sourceSessionId: f.request.sessionId,
    } },
  }]);
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
  scheduleFinalResponseMemory({ service: f.memory, candidates: result.memoryCandidates,
    requestId: f.request.requestId, sessionId: f.request.sessionId });
  expect(f.memory.scheduleCandidates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ candidates: result.memoryCandidates }));
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(RAW_ANSWER);
});

test("a direct greeting fuses initial memory authoring and keeps RAW separate", async () => {
  const f = createSupervisorMemoryFusionFixture({ greeting: true });
  expect((await runRequestRunner(f.request)).output).toBe(RAW_ANSWER);
  expect(f.invoke.mock.calls.map(([input]) => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
    "supervisor_fused_entry_with_memory_candidates", "supervisor.response",
  ]);
  expect(f.invoke.mock.calls.some(([input]) => isAfterChildRouting(input))).toBe(false);
  expect(f.prepare).toHaveBeenCalledOnce();
});

test("different response calibration preserves separate memory authoring without rejecting the answer", async () => {
  const f = createSupervisorMemoryFusionFixture();
  const profile = f.request.modelPolicy!.profiles!.test!;
  const request = deriveTestRequestExecutionScope(f.request, { modelPolicy: {
    ...f.request.modelPolicy!, profiles: { test: { ...profile,
      calibration: { "supervisor.response": { generation: { temperature: 0.9 } } },
    } },
  } });
  const result = await runRequestRunner(request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(afterChildCalls(f).map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
    "supervisor_decision", "supervisor_memory_candidates", "supervisor.response",
  ]);
  expect(result.memoryCandidates).toHaveLength(1);
  expect(f.prepare).toHaveBeenCalledOnce();
});

test("malformed fused candidates neither trigger a routing repair nor a separate authoring call", async () => {
  const f = createSupervisorMemoryFusionFixture({ candidates: "invalid-candidate-channel" });
  const result = await runRequestRunner(f.request);
  expect(result).toEqual({ output: RAW_ANSWER });
  expect(afterChildCalls(f)).toHaveLength(2);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  scheduleFinalResponseMemory({ service: f.memory, candidates: result.memoryCandidates,
    requestId: f.request.requestId, sessionId: f.request.sessionId });
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
});

test("steering discards the stale fused candidate and rebinds the accepted candidate before RAW", async () => {
  const f = createSupervisorMemoryFusionFixture();
  const original = f.invoke.getMockImplementation()!;
  const steering = "Remember that I now prefer detailed answers.";
  let routingCalls = 0;
  f.invoke.mockImplementation(async input => {
    if (!isAfterChildRouting(input)) return original(input);
    routingCalls += 1;
    if (routingCalls === 1) f.requestSteering.append({ steerId: "changed-preference", text: steering });
    return { text: JSON.stringify({ decision: { action: "respond", memoryCandidates: [{
      ...MEMORY_PROPOSAL,
      content: routingCalls === 1 ? "STALE_CANDIDATE" : "The user now prefers detailed answers.",
      explicitRequestQuote: routingCalls === 1 ? null : steering,
    }] } }), meta: {} };
  });
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(routingCalls).toBe(2);
  expect(afterChildCalls(f).map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
    "supervisor_decision_with_memory_candidates", "supervisor_decision_with_memory_candidates", "supervisor.response",
  ]);
  expect(result.memoryCandidates).toMatchObject([{
    content: "The user now prefers detailed answers.", assessment: {
      explicitlyRequested: true, target: MEMORY_KNOWLEDGE.entries[0],
      evidence: { evidenceDigest: createHash("sha256").update(JSON.stringify([f.request.prompt, steering])).digest("hex") },
    },
  }]);
  expect(JSON.stringify(result)).not.toContain("STALE_CANDIDATE");
  expect(f.prepare).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(afterChildCalls(f).at(-1)!.messages)).toContain(steering);
});

test("unavailable knowledge preparation stays secondary and RAW completes without invented candidates", async () => {
  const f = createSupervisorMemoryFusionFixture();
  f.prepare.mockRejectedValue(new Error("knowledge temporarily unavailable"));
  expect(await runRequestRunner(f.request)).toEqual({ output: RAW_ANSWER });
  expect(afterChildCalls(f).map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
    "supervisor_decision", "supervisor.response",
  ]);
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
});

test("measured pressure defers fusion before invocation and preserves the complete separate path", async () => {
  const f = createSupervisorMemoryFusionFixture();
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    const invocation = resolveModelInvocation(input);
    const fused = typeof input.format === "object" && input.format?.name === "supervisor_decision_with_memory_candidates";
    return { inputTokens: fused ? 25_000 : 1_000,
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const request = deriveTestRequestExecutionScope(f.request, {
    modelGatewayClient: { ...f.request.modelGatewayClient, countInputTokens },
  });
  const result = await runRequestRunner(request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(result.memoryCandidates).toHaveLength(1);
  expect(countInputTokens.mock.calls.some(([input]) =>
    typeof input.format === "object" && input.format?.name === "supervisor_decision_with_memory_candidates")).toBe(true);
  expect(afterChildCalls(f).map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
    "supervisor_decision", "supervisor_memory_candidates", "supervisor.response",
  ]);
  for (const input of afterChildCalls(f))
    expect(memoryFusionCapsules(input, "runtime_child_result")).toMatchObject([{ summary: CHILD_FACT }]);
  expect(f.invoke.mock.calls.some(([input]) => memoryFusionFormat(input) === "supervisor_decision_with_memory_candidates")).toBe(false);
});

test.each([25_000, 33_000])("repair admission at %i tokens preserves the fused attempt budget and hard limit", async inputTokens => {
  const f = createSupervisorMemoryFusionFixture();
  const original = f.invoke.getMockImplementation()!;
  let fusedCalls = 0;
  let pressuredAdmissions = 0;
  f.invoke.mockImplementation(async input => {
    if (input.modelStep?.startsWith("super.compact.")) return { text: CHILD_FACT, meta: {} };
    if (memoryFusionFormat(input) !== "supervisor_decision_with_memory_candidates") return original(input);
    fusedCalls += 1;
    return { text: JSON.stringify({ decision: { action: `invalid_fused_${fusedCalls}` } }), meta: {} };
  });
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    const invocation = resolveModelInvocation(input);
    const pressured = typeof input.format === "object" && input.format?.name === "supervisor_decision_with_memory_candidates" && fusedCalls >= 2;
    const compacted = memoryFusionCapsules(input, "runtime_semantic_compaction_checkpoint_v2").length > 0;
    const pressureResolved = compacted && inputTokens <= 32_000;
    if (pressured) pressuredAdmissions += 1;
    return { inputTokens: pressured && !pressureResolved ? inputTokens : 1_000,
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const configured = deriveTestRequestExecutionScope(f.request, { runnerConfig: {
    ...f.request.runnerConfig, steps: { ...f.request.runnerConfig.steps, "context.compact": { timeoutMs: 20_000 } },
  } });
  const request = deriveTestRequestExecutionScope(configured, {
    ...projectSuperCompactionConfiguration(configured, configured.executionPolicy.authority),
    modelGatewayClient: { ...f.request.modelGatewayClient, countInputTokens },
  });
  const result = runRequestRunner(request);
  if (inputTokens > 32_000) await expect(result).rejects.toThrow("context_compaction_projection_not_reduced");
  else await expect(result).resolves.toMatchObject({ disposition: "blocked" });
  expect(pressuredAdmissions).toBeGreaterThan(0);
  expect(fusedCalls).toBe(inputTokens > 32_000 ? 2 : 3);
  expect(afterChildCalls(f).filter(input => input.modelStep === "supervisor.decision").map(memoryFusionFormat))
    .toEqual(Array(fusedCalls).fill("supervisor_decision_with_memory_candidates"));
  expect(f.invoke.mock.calls.some(([input]) => input.modelStep === "super.compact.continuation")).toBe(true);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
});

test("primary cancellation during fused preparation cannot fall through to routing or RAW", async () => {
  const f = createSupervisorMemoryFusionFixture();
  const abort = new AbortController();
  const failure = new Error("cancelled during fused memory preparation");
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  f.prepare.mockImplementation(async () => {
    markStarted();
    return new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
  });
  const request = deriveTestRequestExecutionScope(f.request, { abortSignal: abort.signal });
  const rejected = expect(runRequestRunner(request)).rejects.toBe(failure);
  await started;
  abort.abort(failure);
  await rejected;
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.request.onAnswerToken).not.toHaveBeenCalled();
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
});

test("different configured guidance stays scoped to memory during fusion and remains original in RAW", async () => {
  const f = createSupervisorMemoryFusionFixture();
  const decisionContent = "ROUTING_GUIDANCE: Decide whether the comparison is complete.";
  const responseContent = "MEMORY_AND_PRESENTATION_GUIDANCE: Assess durable preferences.\nPresent supported facts accurately.";
  const request = deriveTestRequestExecutionScope(f.request, { runnerConfig: {
    ...f.request.runnerConfig, steps: {
      ...f.request.runnerConfig.steps,
      "supervisor.decision": { timeoutMs: 20_000, instructionBlocks: [
        { ref: "routing", contentHash: "routing-hash", content: decisionContent },
      ] },
      "supervisor.response": { timeoutMs: 20_000, instructionBlocks: [
        { ref: "response", contentHash: "response-hash", content: responseContent },
      ] },
    },
  } });
  expect((await runRequestRunner(request)).output).toBe(RAW_ANSWER);
  const calls = afterChildCalls(f);
  expect(calls.map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
    "supervisor_decision_with_memory_candidates", "supervisor.response",
  ]);
  const routingText = (calls[0]!.messages as readonly ChatMessage[]).map(message => message.content).join("\n");
  const responseText = (calls[1]!.messages as readonly ChatMessage[]).map(message => message.content).join("\n");
  const scopedGuidance = buildSupervisorMemoryConfiguredGuidance(request)!;
  expect(routingText.split(scopedGuidance)).toHaveLength(2);
  expect(routingText.split(responseContent)).toHaveLength(2);
  expect(routingText).toContain(decisionContent);
  expect(responseText.split(responseContent)).toHaveLength(2);
  expect(responseText).not.toContain(scopedGuidance);
  expect(responseText).not.toContain(decisionContent);
  expect(responseText).not.toContain("conversation_memory_authoring_reference_v1");
  expect(calls[1]).not.toHaveProperty("format");
});
