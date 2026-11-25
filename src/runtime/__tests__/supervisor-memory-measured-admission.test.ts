import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { requiresContextCompaction } from "../model/context-compaction-admission.js";
import { resolveModelContextBudget } from "../model/model-context-budget.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createSupervisorMemoryFusionFixture, isAfterChildRouting, MEMORY_KNOWLEDGE,
  memoryFusionCapsules, memoryFusionFormat, RAW_ANSWER, type MemoryFusionInput,
} from "./support/supervisor-memory-fusion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const MEMORY_FORMAT = "supervisor_decision_with_memory_candidates";
const MEMORY_REFERENCE = "conversation_memory_authoring_reference_v1";
const GUIDE = { skillId: "comparison-response", name: "Comparison response",
  description: "Present the completed cobalt comparison.", content: "Explain the observed cobalt fact." };
const LARGE_MEMORY_CONTENT = `FULL_MEMORY_START:${"established preference context; ".repeat(1_050)}:FULL_MEMORY_END`;

function createMeasuredFixture(mode: "fit" | "high" | "unavailable") {
  const f = createSupervisorMemoryFusionFixture();
  const knowledge = { ...structuredClone(MEMORY_KNOWLEDGE), entries: MEMORY_KNOWLEDGE.entries.map(
    (entry, index) => ({ ...entry, ...(index === 0 ? { content: LARGE_MEMORY_CONTENT } : {}) }),
  ) };
  f.prepare.mockResolvedValue(knowledge);
  const source = createKnowledgeSkillStore([GUIDE]);
  const store = { ...source, read: vi.fn(source.read) };
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    if (mode === "unavailable") return undefined;
    const invocation = resolveModelInvocation(input);
    return { inputTokens: mode === "high" && memoryFusionFormat(input) === MEMORY_FORMAT ? 25_000 : 1_000,
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const request = createRequestExecutionScope({
    seed: { ...f.request, modelGatewayClient: { ...f.request.modelGatewayClient, countInputTokens } },
    executionPolicy: f.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  const estimate = (input: MemoryFusionInput) => assessRequestMessagesBudget({
    messages: input.messages as readonly ChatMessage[], format: input.format as ModelGatewayJsonSchemaFormat,
    budget: resolveModelContextBudget({ runnerConfig: request.runnerConfig, agentMode: request.agentMode,
      modelStep: input.modelStep!, modelPolicy: request.modelPolicy }),
  });
  const postChildCalls = () => {
    const calls = f.invoke.mock.calls.map(([input]) => input);
    return calls.slice(calls.findIndex(input => input.modelStep === "worker.result") + 1);
  };
  const measuredUnion = () => {
    const input = countInputTokens.mock.calls.map(([input]) => input)
      .find(input => memoryFusionFormat(input) === MEMORY_FORMAT);
    expect(input).toBeDefined();
    const estimated = estimate(input!);
    expect(estimated.budget.estimatedInputTokens).toBeGreaterThan(estimated.budget.compactionTriggerInputTokens);
    expect(requiresContextCompaction(true, estimated)).toBe(true);
    return input!;
  };
  return { ...f, request, store, countInputTokens, postChildCalls, measuredUnion, knowledge, estimate };
}

function expectWholeMemory(input: MemoryFusionInput) {
  expect(memoryFusionCapsules(input, MEMORY_REFERENCE)).toMatchObject([{ omitted: 0, entries: [
    { ref: "k1", content: LARGE_MEMORY_CONTENT, mutable: true },
    { ref: "k2", content: MEMORY_KNOWLEDGE.entries[1]!.content, mutable: false },
  ] }]);
}

test("an overestimated complete memory union uses the fitting provider count and keeps two post-child calls", async () => {
  const f = createMeasuredFixture("fit");
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(RAW_ANSWER);
  expectWholeMemory(f.measuredUnion());
  const calls = f.postChildCalls();
  expect(calls.map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([MEMORY_FORMAT, "supervisor.response"]);
  expect(isAfterChildRouting(calls[0]!)).toBe(true);
  expect(JSON.stringify(calls[0]!.format)).toContain('"read_skills"');
  expectWholeMemory(calls[0]!);
  expect(result.memoryCandidates).toMatchObject([{ assessment: { target: {
    id: f.knowledge.entries[0]!.id, version: "7", content: LARGE_MEMORY_CONTENT,
  } } }]);
  expect(memoryFusionCapsules(calls[1]!, MEMORY_REFERENCE)).toEqual([]);
  expect(calls[1]).not.toHaveProperty("format");
  expect(f.store.read).not.toHaveBeenCalled();
});

test.each(["high", "unavailable"] as const)(
  "%s provider count conservatively drops only memory and retains combined Skill/routing", async mode => {
    const f = createMeasuredFixture(mode);
    const result = await runRequestRunner(f.request);
    expect(result.output).toBe(RAW_ANSWER);
    expectWholeMemory(f.measuredUnion());
    const calls = f.postChildCalls();
    expect(calls.map(input => memoryFusionFormat(input) ?? input.modelStep)).toEqual([
      "supervisor_resume_skill_routing", "supervisor_memory_candidates", "supervisor.response",
    ]);
    expect(JSON.stringify(calls[0]!.format)).toContain('"read_skills"');
    expect(memoryFusionCapsules(calls[0]!, MEMORY_REFERENCE)).toEqual([]);
    expectWholeMemory(calls[1]!);
    expect(requiresContextCompaction(true, f.estimate(calls[1]!))).toBe(false);
    expect(result.memoryCandidates).toMatchObject([{ assessment: { target: {
      id: f.knowledge.entries[0]!.id, version: "7", content: LARGE_MEMORY_CONTENT,
    } } }]);
    expect(calls[2]).not.toHaveProperty("format");
    expect(f.invoke.mock.calls.some(([input]) => memoryFusionFormat(input) === "supervisor_skill_selection")).toBe(false);
    expect(f.invoke.mock.calls.some(([input]) => memoryFusionFormat(input) === MEMORY_FORMAT)).toBe(false);
    expect(f.store.read).not.toHaveBeenCalled();
  },
);
