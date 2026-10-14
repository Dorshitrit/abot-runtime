import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRootInvalidOutputRequest,
  INVALID_OUTPUT_MODEL_POLICY,
  INVALID_OUTPUT_RUNNER_CONFIG,
} from "./support/root-invalid-output-fixture.js";
import { deriveTestRequestExecutionScope, type TestRequestSeed } from "./support/request-execution-scope.js";
import {
  createRootCompactionFixture,
  HISTORY_FACT,
} from "./support/root-compaction-fixture.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

const respond = (response?: string) => JSON.stringify({
  decision: {
    action: "respond",
    acknowledgement: "I will answer.",
    ...(response === undefined ? {} : { response }),
  },
});

function offersDirectResponse(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(offersDirectResponse);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  const action = properties?.action as { enum?: unknown[]; const?: unknown } | undefined;
  if ((action?.enum?.includes("respond") || action?.const === "respond")
    && properties?.response !== undefined) return true;
  return Object.values(record).some(offersDirectResponse);
}

const specialCases: readonly {
  name: string;
  overrides: Partial<TestRequestSeed>;
  answer: string;
}[] = [
  {
    name: "automation output",
    overrides: { automationOutputContract: {
      type: "object", additionalProperties: false,
      properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"],
    } },
    answer: '{"answer":"schema-validated result"}',
  },
  {
    name: "scheduled execution",
    overrides: { scheduledExecution: {
      jobId: "job-1", runId: "run-1", title: "Saved task",
      scheduledAt: "2026-10-13T09:00:00Z", triggerType: "schedule",
    } },
    answer: "The saved task result.",
  },
  {
    name: "Spark session",
    overrides: { sessionKind: "spark" },
    answer: "The companion answer.",
  },
];

test.each(specialCases)("$name retains its deferred response contract", async ({ overrides, answer }) => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "execution.decision") {
      expect(offersDirectResponse(input.format)).toBe(false);
      return { text: respond(), meta: {} };
    }
    expect(input.modelStep).toBe("execution.response");
    if (overrides.automationOutputContract)
      expect(input.format).toMatchObject({ name: "automation_step_result" });
    return { text: answer, meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", overrides);

  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision", "execution.response",
  ]);
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
});

test("enabled long-term memory offers direct authoring while deferred candidates remain available", async () => {
  const answer = "The complete memory-aware answer.";
  const candidate = { content: "The user prefers concise explanations.", tags: ["preference"] };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "execution.decision") {
      expect(offersDirectResponse(input.format)).toBe(true);
      return { text: respond(), meta: {} };
    }
    expect(input.modelStep).toBe("execution.response");
    return {
      text: JSON.stringify({ finalResponse: answer, memoryCandidates: [candidate] }),
      meta: {},
    };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    longTermMemory: {
      enabled: true,
      retrieve: vi.fn(async () => ({ available: true, records: [] })),
      processCandidates: vi.fn(), scheduleCandidates: vi.fn(),
      status: vi.fn(), list: vi.fn(), search: vi.fn(), create: vi.fn(),
      update: vi.fn(), delete: vi.fn(), clear: vi.fn(),
    },
  });

  await expect(runRequestRunner(request)).resolves.toMatchObject({
    output: answer, memoryCandidates: [candidate],
  });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision", "execution.response",
  ]);
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
});

test("a direct answer can use verified compacted history without a response call", async () => {
  const fixture = await createRootCompactionFixture("execution-agent-v1", {
    noActiveEvidence: true,
    prompt: "Summarize the corrected deployment location from our conversation.",
  });
  const request = deriveTestRequestExecutionScope(fixture.request, {
    runnerConfig: {
      ...fixture.request.runnerConfig,
      steps: {
        ...fixture.request.runnerConfig.steps,
        "execution.response": { timeoutMs: 20000 },
      },
    },
  });
  const originalInvoke = fixture.invoke.getMockImplementation()!;
  const answer = "The latest correction says the deployment is north.";
  fixture.invoke.mockImplementation(async (input) => {
    if (input.modelStep === "context.compact") return originalInvoke(input);
    expect(input.modelStep).toBe("execution.decision");
    expect(offersDirectResponse(input.format)).toBe(true);
    expect(JSON.stringify(input.messages)).toContain(HISTORY_FACT);
    expect(JSON.stringify(input.messages)).not.toContain("old detail");
    return { text: respond(answer), meta: {} };
  });
  vi.mocked(fixture.request.modelGatewayClient.countInputTokens!)
    .mockImplementation(async (input) => ({
      inputTokens: input.modelStep === "context.compact"
        || JSON.stringify(input.messages).includes("runtime_session_memory_checkpoint_v1")
        ? 1000 : 24000,
      profileId: "compaction-test", provider: "openai", model: "compaction-test-model",
      contextWindowTokens: 32000, source: "provider_input_token_count",
    }));

  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "context.compact", "execution.decision",
  ]);
  expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
  expect(fixture.sessionMemory.project().historyMessages).toHaveLength(20);
});

test("tracked public defaults offer direct response with response methodologies projected once", async () => {
  const config = loadPublicRuntimeConfig([]);
  const runnerConfig = loadRequestRunnerConfig(config.requestRunner!);
  const blocks = runnerConfig.steps["execution.response"]!.instructionBlocks!;
  expect(blocks.length).toBeGreaterThan(0);
  const answer = "A complete short public-default answer.";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(input.modelStep).toBe("execution.decision");
    expect(offersDirectResponse(input.format)).toBe(true);
    const serialized = (input.messages as readonly { content: string }[])
      .map(({ content }) => content).join("\n");
    for (const block of blocks)
      expect(serialized.split(block.content)).toHaveLength(2);
    return { text: respond(answer), meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    runnerConfig, modelPolicy: config.models,
    modelPreference: { profileId: "default", scope: "all" },
    executionPolicySelection: {
      policy: "execution-agent-v1", source: "model_profile", primaryProfileId: "default",
    },
  });

  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
});

test.each([
  { contextWindowTokens: 32_000, memoryEnabled: false },
  { contextWindowTokens: 36_000, memoryEnabled: false },
  { contextWindowTokens: 128_000, memoryEnabled: false },
  { contextWindowTokens: 32_000, memoryEnabled: true },
  { contextWindowTokens: 128_000, memoryEnabled: true },
  { contextWindowTokens: 48_000, memoryEnabled: false, calibrated: true },
  { contextWindowTokens: 128_000, memoryEnabled: false, calibrated: true },
  { contextWindowTokens: 48_000, memoryEnabled: true, calibrated: true },
  { contextWindowTokens: 128_000, memoryEnabled: true, calibrated: true },
])("$contextWindowTokens-token context with memory=$memoryEnabled and calibration=$calibrated retains direct response when the measured input fits", async ({ contextWindowTokens, memoryEnabled, calibrated }) => {
  const methodology = "Response presentation guidance. ".repeat(memoryEnabled || calibrated ? 800 : 1_000);
  const answer = "A complete answer within the configured context.";
  const memoryMessage = { role: "system" as const, content: "Stored preference: concise answers." };
  const retrieve = vi.fn(async () => ({ available: true, records: [], message: memoryMessage }));
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    expect(offersDirectResponse(input.format)).toBe(true);
    return { inputTokens: 6_686, profileId: "invalid-output-test", provider: "ollama",
      model: "invalid-output-test", contextWindowTokens, source: "provider_input_token_count" };
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async input => {
    const text = JSON.stringify(input.messages);
    if (memoryEnabled) {
      expect((input.messages as readonly { content: string }[])
        .filter(message => message.content === memoryMessage.content)).toEqual([memoryMessage]);
    }
    expect(input.modelStep).toBe("execution.decision");
    expect(offersDirectResponse(input.format)).toBe(true);
    expect(text).toContain(methodology);
    const output = JSON.parse(respond(answer));
    if (memoryEnabled) output.decision.memoryCandidates = [];
    return { text: JSON.stringify(output), meta: {} };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    ...(memoryEnabled ? { longTermMemory: {
      enabled: true, retrieve, processCandidates: vi.fn(), scheduleCandidates: vi.fn(),
      status: vi.fn(), list: vi.fn(), search: vi.fn(), create: vi.fn(),
      update: vi.fn(), delete: vi.fn(), clear: vi.fn(),
    } } : {}),
    runnerConfig: {
      ...INVALID_OUTPUT_RUNNER_CONFIG,
      steps: { ...INVALID_OUTPUT_RUNNER_CONFIG.steps,
        "execution.decision": { timeoutMs: 20_000, instructionBlocks: [
          { ref: "decision-budget-fixture", contentHash: "fixture", content: "Decision guidance. ".repeat(800) },
        ] },
        "execution.response": { timeoutMs: 20_000, instructionBlocks: [
          { ref: "response-budget-fixture", contentHash: "fixture", content: methodology },
        ] },
      },
    },
    modelPolicy: { ...INVALID_OUTPUT_MODEL_POLICY, profiles: {
      "invalid-output-test": {
        ...INVALID_OUTPUT_MODEL_POLICY.profiles["invalid-output-test"], contextWindowTokens,
        ...(calibrated ? { calibration: Object.fromEntries(
          ["execution.decision", "execution.response"].map(step => [step, {
            instructions: ["  ", "  Profile calibration guidance. ".repeat(1_000)],
          }]),
        ) } : {}),
      },
    } },
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: answer });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["execution.decision"]);
  expect(countInputTokens).toHaveBeenCalledOnce();
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(answer);
  expect(retrieve).toHaveBeenCalledTimes(memoryEnabled ? 1 : 0);
});

test.each([24_000, 40_000])("a measured %i-token input still uses the existing context guard with direct response offered", async inputTokens => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    expect(offersDirectResponse(input.format)).toBe(true);
    return { inputTokens, profileId: "invalid-output-test", provider: "ollama",
      model: "invalid-output-test", contextWindowTokens: 32_000, source: "provider_input_token_count" };
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    modelPolicy: { ...INVALID_OUTPUT_MODEL_POLICY, profiles: {
      "invalid-output-test": {
        ...INVALID_OUTPUT_MODEL_POLICY.profiles["invalid-output-test"], contextWindowTokens: 32_000,
      },
    } },
  });
  await expect(runRequestRunner(request)).rejects.toThrow("context_compaction_sources_empty");
  expect(countInputTokens).toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
