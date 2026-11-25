import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { ProviderContextOverflowError } from "../../model-gateway/protocol/provider-context-overflow.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  CHILD_FACT, createSupervisorMemoryFusionFixture, MEMORY_KNOWLEDGE,
  MEMORY_PROPOSAL, memoryFusionCapsules, memoryFusionFormat, RAW_ANSWER,
  type MemoryFusionInput,
} from "./support/supervisor-memory-fusion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const FUSED_FORMAT = "supervisor_decision_with_memory_candidates";
const MEMORY_CAPSULE = "conversation_memory_authoring_reference_v1";
const CHECKPOINT_CAPSULE = "runtime_semantic_compaction_checkpoint_v2";
const RESPONSE_GUIDANCE = "Assess only supported durable preferences; present confirmed facts accurately.";
const ORIGINAL_CHILD_DETAIL = `${CHILD_FACT}\n${"The supplied comparison observed cobalt pigment. ".repeat(120)}`.trim();

function providerOverflow() {
  return new ModelGatewayInvocationError("http", "provider context rejected", {
    cause: new ProviderContextOverflowError(),
  });
}

function hasCheckpoint(input: MemoryFusionInput): boolean {
  return memoryFusionCapsules(input, CHECKPOINT_CAPSULE).length > 0;
}

function firstMessage(input: MemoryFusionInput): ChatMessage {
  return (input.messages as readonly ChatMessage[])[0]!;
}

/** Real runner, ledger, checkpoint generation and admission; only provider outputs are scripted. */
function createOverflowFixture(mode: "recover" | "overflow_twice" | "repair_then_overflow") {
  const f = createSupervisorMemoryFusionFixture();
  const original = f.invoke.getMockImplementation()!;
  let fusedAttempts = 0;
  f.invoke.mockImplementation(async input => {
    if (input.modelStep?.startsWith("super.compact."))
      return { text: CHILD_FACT, meta: {} };
    if (input.modelStep === "worker.result")
      return { text: ORIGINAL_CHILD_DETAIL, meta: {} };
    if (memoryFusionFormat(input) !== FUSED_FORMAT) return original(input);
    fusedAttempts += 1;
    if (mode === "overflow_twice") throw providerOverflow();
    if (mode === "repair_then_overflow" && fusedAttempts === 2) throw providerOverflow();
    if (mode === "repair_then_overflow") return {
      text: JSON.stringify({ decision: { action: `invalid_routing_${fusedAttempts}` } }), meta: {},
    };
    if (fusedAttempts === 1) throw providerOverflow();
    return { text: JSON.stringify({ decision: {
      action: "respond", memoryCandidates: [MEMORY_PROPOSAL],
    } }), meta: {} };
  });
  const configured = deriveTestRequestExecutionScope(f.request, {
    runnerConfig: { ...f.request.runnerConfig, steps: {
      ...f.request.runnerConfig.steps,
      "context.compact": { timeoutMs: 20_000 },
      "supervisor.response": { timeoutMs: 20_000, instructionBlocks: [
        { ref: "response", contentHash: "overflow-response-guidance", content: RESPONSE_GUIDANCE },
      ] },
    } },
  });
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    const invocation = resolveModelInvocation(input);
    const fused = memoryFusionFormat(input) === FUSED_FORMAT;
    const fusedInputTokens = hasCheckpoint(input) ? 6_000 : 10_000;
    return {
      inputTokens: fused ? fusedInputTokens : 1_000,
      profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  const request = deriveTestRequestExecutionScope(configured, {
    ...projectSuperCompactionConfiguration(configured, configured.executionPolicy.authority),
    modelGatewayClient: { ...configured.modelGatewayClient, countInputTokens },
  });
  const calls = () => f.invoke.mock.calls.map(([input]) => input);
  const fusedCalls = () => calls().filter(input => memoryFusionFormat(input) === FUSED_FORMAT);
  const compactionCalls = () => calls().filter(input => input.modelStep?.startsWith("super.compact."));
  return { ...f, request, calls, fusedCalls, compactionCalls, countInputTokens };
}

test("typed provider overflow compacts once and retries fused routing with exact memory before RAW", async () => {
  const f = createOverflowFixture("recover");
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(f.fusedCalls()).toHaveLength(2);
  const [before, after] = f.fusedCalls();
  expect(hasCheckpoint(before!)).toBe(false);
  expect(hasCheckpoint(after!)).toBe(true);
  expect(memoryFusionCapsules(before!, "runtime_child_result")[0]?.summary).toBe(ORIGINAL_CHILD_DETAIL);
  expect(JSON.stringify(after!.messages)).not.toContain("The supplied comparison observed cobalt pigment.");
  expect(memoryFusionCapsules(after!, MEMORY_CAPSULE))
    .toEqual(memoryFusionCapsules(before!, MEMORY_CAPSULE));
  expect(memoryFusionCapsules(after!, MEMORY_CAPSULE)).toHaveLength(1);
  expect(firstMessage(after!)).toEqual(firstMessage(before!));
  expect(firstMessage(after!).content.split(RESPONSE_GUIDANCE)).toHaveLength(2);
  expect(result.memoryCandidates).toMatchObject([{
    content: MEMORY_PROPOSAL.content,
    assessment: { target: MEMORY_KNOWLEDGE.entries[0], evidence: {
      sourceRequestId: f.request.requestId, sourceSessionId: f.request.sessionId,
    } },
  }]);
  expect(f.compactionCalls().map(input => input.modelStep)).toEqual([
    "super.compact.coverage", "super.compact.content", "super.compact.continuation",
  ]);
  const raw = f.calls().filter(input => input.modelStep === "supervisor.response" && input.format === undefined);
  expect(raw).toHaveLength(1);
  expect(hasCheckpoint(raw[0]!)).toBe(true);
  expect(firstMessage(raw[0]!).content.split(RESPONSE_GUIDANCE)).toHaveLength(2);
  expect(f.calls().some(input => memoryFusionFormat(input) === "supervisor_memory_candidates")).toBe(false);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(RAW_ANSWER);
});

test("a second fused provider overflow is terminal without another checkpoint cycle or RAW", async () => {
  const f = createOverflowFixture("overflow_twice");
  await expect(runRequestRunner(f.request)).rejects.toThrow("provider context rejected");
  expect(f.fusedCalls()).toHaveLength(2);
  expect(f.compactionCalls().filter(input => input.modelStep === "super.compact.continuation")).toHaveLength(1);
  expect(f.calls().some(input => input.modelStep === "supervisor.response")).toBe(false);
  expect(f.request.onAnswerToken).not.toHaveBeenCalled();
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
});

test("overflow during structured repair preserves the original two-repair allowance", async () => {
  const f = createOverflowFixture("repair_then_overflow");
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ disposition: "blocked" });
  // Three invalid outputs plus one provider overflow; recovery must not restart the parser loop.
  expect(f.fusedCalls()).toHaveLength(4);
  expect(f.fusedCalls().map(hasCheckpoint)).toEqual([false, false, true, true]);
  expect(f.compactionCalls().filter(input => input.modelStep === "super.compact.continuation")).toHaveLength(1);
  expect(f.calls().some(input => input.modelStep === "supervisor.response")).toBe(false);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
});
