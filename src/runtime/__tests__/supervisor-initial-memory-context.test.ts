import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { projectLongTermMemoryMessage } from "../long-term-memory/projection.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { createMemoryRecallHarness, MEMORY_RECORD, modelMessages } from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createRootCompactionFixture, HISTORY_FACT } from "./support/root-compaction-fixture.js";
import { supervisorFormatName, withSupervisorPreparation } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { vi.restoreAllMocks(); resetDebugLoggerConfig(); });
const message = projectLongTermMemoryMessage([MEMORY_RECORD])!;

test("startup memory participates in the existing input budget without changing routing schema or user intent", () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }) });
  const options = { toolResults: { sourceRevision: 0, results: [] } };
  const baseline = buildSupervisorDecisionInput(f.request, options);
  const enriched = buildSupervisorDecisionInput(f.request, { ...options, initialMemoryMessage: message });
  expect(enriched.format).toEqual(baseline.format);
  expect(enriched.context.selectedHistoryMessageIds).toEqual(baseline.context.selectedHistoryMessageIds);
  expect(enriched.context.messages.filter(entry => entry.content === f.request.prompt)).toEqual(
    baseline.context.messages.filter(entry => entry.content === f.request.prompt),
  );
  expect(enriched.context.messages.filter(entry => entry.content === message.content)).toEqual([message]);
  expect(enriched.context.budget.parts.referenceInputTokens).toBeGreaterThan(baseline.context.budget.parts.referenceInputTokens);
  expect(enriched.context.budget.estimatedInputTokens).toBeGreaterThan(baseline.context.budget.estimatedInputTokens);
});

test("session compaction retains initial memory in SUPER routing and RAW response without retrieving again", async () => {
  const f = await createRootCompactionFixture("supervisor-worker-v1", { noActiveEvidence: true });
  const memoryHarness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }),
    retrieve: async () => ({ available: true, records: [MEMORY_RECORD], message }),
  });
  const request = deriveTestRequestExecutionScope(f.request, {
    longTermMemory: memoryHarness.memory,
    runnerConfig: { ...f.request.runnerConfig, steps: {
      ...f.request.runnerConfig.steps, "supervisor.response": { timeoutMs: 20_000 },
    } },
  });
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(withSupervisorPreparation(async input => {
    if (input.modelStep === "context.compact") return original(input);
    expect(modelMessages(input)).toContainEqual(message);
    expect(JSON.stringify(input.messages)).toContain(HISTORY_FACT);
    expect(JSON.stringify(input.messages)).not.toContain("old detail");
    if (input.modelStep === "supervisor.response") {
      if (input.format) return { text: JSON.stringify({ memoryCandidates: [] }), meta: {} };
      return { text: "A memory-informed answer.", meta: {} };
    }
    return { text: JSON.stringify({ decision: {
      action: "respond", acknowledgement: "I will answer.", responseRecommendation: "Answer the current request.",
    } }), meta: {} };
  }));
  vi.mocked(f.request.modelGatewayClient.countInputTokens!).mockImplementation(async input => ({
    inputTokens: input.modelStep === "context.compact"
      || JSON.stringify(input.messages).includes("runtime_session_memory_checkpoint_v1") ? 1000 : 24000,
    profileId: "compaction-test", provider: "openai", model: "compaction-test-model",
    contextWindowTokens: 32000, source: "provider_input_token_count",
  }));
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: "A memory-informed answer." });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "supervisor.decision", "context.compact", "supervisor.decision", "supervisor.response", "supervisor.response",
  ]);
  for (const [input] of f.invoke.mock.calls) {
    if (input.modelStep === "context.compact") continue;
    if (supervisorFormatName(input) === "supervisor_presentation") {
      expect(modelMessages(input)).not.toContainEqual(message);
      expect(JSON.stringify(input.messages)).not.toContain(HISTORY_FACT);
      continue;
    }
    expect(modelMessages(input)).toContainEqual(message);
    expect(JSON.stringify(input.messages)).toContain(HISTORY_FACT);
    expect(JSON.stringify(input.messages)).not.toContain("old detail");
  }
  expect(f.invoke.mock.calls.at(-2)![0].format).toMatchObject({ name: "supervisor_memory_candidates" });
  expect(f.invoke.mock.calls.at(-1)![0].format).toBeUndefined();
  expect(memoryHarness.memory.retrieve).toHaveBeenCalledOnce();
});
