import { supervisorFormatName, withSupervisorPreparation } from "./support/supervisor-model-phases.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { projectLongTermMemoryMessage } from "../long-term-memory/projection.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { runRequestRunner } from "../request/runner.js";
import { SUPERVISOR_RESPONSE_RECOMMENDATION_KIND } from "../steps/supervisor-response/response-recommendation.js";
import { runSupervisorAuthoredResponse } from "../steps/supervisor-response/run.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
const PROMPT = "Explain the supplied distinction.";
const STEERING = "Explain only the first point.";
const OLD_RECOMMENDATION = "Explain both points in the supplied distinction.";
const FRESH_RECOMMENDATION =
  "Explain only the first point in the supplied distinction.";
const PASSIVE_MEMORY_TEXT = "PASSIVE_MEMORY_SENTINEL: use the stored presentation preference.";
const STALE_CANDIDATE = { content: "Old candidate.", tags: [] };
const FRESH_CANDIDATE = { content: "Fresh candidate.", tags: [] };
const CALL = {
  rootCallId: "call-1",
  callId: "call-1",
  parentCallId: null,
  depth: 0,
  invocationAttempt: 1,
};
const BOUND_OPTIONS = {
  call: CALL,
  toolResults: { sourceRevision: 1, results: [] },
  responseRecommendation: OLD_RECOMMENDATION,
  steeringSnapshot: { version: 0, updates: [] },
};

function createHarness(
  invoke: ModelGatewayClient["invoke"],
  retrieve: LongTermMemoryService["retrieve"] = async () => ({
    available: true,
    records: [],
  }),
) {
  const abortController = new AbortController();
  const memory = {
    enabled: true,
    retrieve: vi.fn(retrieve),
    processCandidates: vi.fn(),
    scheduleCandidates: vi.fn(),
    status: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  } satisfies LongTermMemoryService;
  const request = createTestRequestExecutionScope({
    requestId: "recommendation-memory-steering",
    sessionId: "recommendation-memory-session",
    prompt: PROMPT,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    requestSteering: createRequestSteeringInbox({
      requestId: "recommendation-memory-steering",
    }),
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: {
        "supervisor.decision": { timeoutMs: 20_000 },
        "supervisor.response": { timeoutMs: 20_000 },
      },
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        test: { provider: "local", model: "test", contextWindowTokens: 32_000 },
      },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke: withSupervisorPreparation(invoke), invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: vi.fn(() => []),
    },
    longTermMemory: memory,
    toolPermissionMode: "full_access",
    abortSignal: abortController.signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  return { request, memory, abortController };
}

function invocationPhase(input: ModelInput): string {
  if (supervisorFormatName(input) === "supervisor_procedure_gate") return "gate";
  if (input.format === undefined) return "response";
  return "memory";
}

function assertMemoryInput(input: ModelInput): void {
  expect(input.modelStep).toBe("supervisor.response");
  expect(input.format).toMatchObject({ name: "supervisor_memory_candidates" });
  expect(JSON.stringify(input.messages)).not.toContain(
    SUPERVISOR_RESPONSE_RECOMMENDATION_KIND,
  );
  expect(JSON.stringify(input.messages)).not.toContain(OLD_RECOMMENDATION);
  expect(JSON.stringify(input.messages)).not.toContain(FRESH_RECOMMENDATION);
}

function directResponseGate(recommendation: string): string {
  return JSON.stringify({
    decision: { requiresProcedure: false, responseRecommendation: recommendation },
  });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test("stale entry prevents memory retrieval and every provider invocation", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>().mockResolvedValue({
    text: JSON.stringify({ memoryCandidates: [] }),
    meta: {},
  });
  const { request, memory } = createHarness(invoke);
  request.requestSteering!.append({ steerId: "already-stale", text: STEERING });
  await expect(
    runSupervisorAuthoredResponse(request, BOUND_OPTIONS),
  ).rejects.toMatchObject({ name: "ModelStepSteeringSupersededError" });
  expect(memory.retrieve).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

test("startup steering and readable passive memory reach the gate while response keeps the original capsule", async () => {
  let decisionCount = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (invocationPhase(input) === "gate") {
      decisionCount += 1;
      expect(JSON.stringify(input.messages)).toContain(STEERING);
      expect(JSON.stringify(input.messages)).toContain(PASSIVE_MEMORY_TEXT);
      expect(JSON.stringify(input.messages)).not.toContain("runtime_long_term_memory_reference_v1");
      return {
        text: directResponseGate(FRESH_RECOMMENDATION),
        meta: {},
      };
    }
    expect(decisionCount).toBe(1);
    expect(JSON.stringify(input.messages)).toContain(STEERING);
    if (invocationPhase(input) === "memory") {
      assertMemoryInput(input);
      return {
        text: JSON.stringify({ memoryCandidates: [FRESH_CANDIDATE] }),
        meta: {},
      };
    }
    expect(JSON.stringify(input.messages)).toContain(FRESH_RECOMMENDATION);
    expect(JSON.stringify(input.messages)).not.toContain(OLD_RECOMMENDATION);
    expect(JSON.stringify(input.messages)).toContain(PASSIVE_MEMORY_TEXT);
    expect(JSON.stringify(input.messages)).toContain("runtime_long_term_memory_reference_v1");
    return { text: "Fresh answer.", meta: {} };
  });
  const { request, memory } = createHarness(invoke, async () => {
    if (decisionCount === 0)
      request.requestSteering!.append({
        steerId: "during-retrieval",
        text: STEERING,
      });
    const records = [{
      id: "presentation-preference", content: PASSIVE_MEMORY_TEXT, tags: ["presentation"],
      provenance: { kind: "passive_response", sourceRequestId: "prior-request", sourceSessionId: "prior-session" },
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    }] as const;
    return { available: true, records, message: projectLongTermMemoryMessage(records) };
  });
  await expect(runRequestRunner(request)).resolves.toEqual({
    output: "Fresh answer.",
    memoryCandidates: [FRESH_CANDIDATE],
  });
  expect(invoke.mock.calls.map(([input]) => invocationPhase(input))).toEqual([
    "gate",
    "memory",
    "response",
  ]);
  expect(memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([
    PROMPT,
  ]);
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
    "Fresh answer.",
  );
});

test.each([
  {
    label: "valid candidates",
    output: JSON.stringify({ memoryCandidates: [STALE_CANDIDATE] }),
  },
  { label: "invalid output", output: "" },
])(
  "steering during memory authoring skips local retry and stale candidates: $label",
  async ({ output }) => {
    let decisionCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (invocationPhase(input) === "gate") {
        decisionCount += 1;
        return {
          text: directResponseGate(
            decisionCount === 1 ? OLD_RECOMMENDATION : FRESH_RECOMMENDATION,
          ),
          meta: {},
        };
      }
      if (invocationPhase(input) === "memory") {
        assertMemoryInput(input);
        if (decisionCount === 1) {
          request.requestSteering!.append({
            steerId: "during-memory",
            text: STEERING,
          });
          return { text: output, meta: {} };
        }
        expect(JSON.stringify(input.messages)).toContain(STEERING);
        return {
          text: JSON.stringify({ memoryCandidates: [FRESH_CANDIDATE] }),
          meta: {},
        };
      }
      expect(decisionCount).toBe(2);
      expect(JSON.stringify(input.messages)).toContain(FRESH_RECOMMENDATION);
      expect(JSON.stringify(input.messages)).not.toContain(OLD_RECOMMENDATION);
      return { text: "Fresh answer.", meta: {} };
    });
    const { request } = createHarness(invoke);
    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Fresh answer.",
      memoryCandidates: [FRESH_CANDIDATE],
    });
    expect(invoke.mock.calls.map(([input]) => invocationPhase(input))).toEqual([
      "gate",
      "memory",
      "gate",
      "memory",
      "response",
    ]);
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      "Fresh answer.",
    );
  },
);

test.each([
  {
    label: "no recommendation",
    responseRecommendation: undefined,
    steeringSnapshot: BOUND_OPTIONS.steeringSnapshot,
  },
  {
    label: "no snapshot",
    responseRecommendation: OLD_RECOMMENDATION,
    steeringSnapshot: undefined,
  },
])(
  "preserves unbound memory retry with $label",
  async ({ responseRecommendation, steeringSnapshot }) => {
    let memoryCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (invocationPhase(input) === "memory") {
        assertMemoryInput(input);
        memoryCount += 1;
        if (memoryCount === 1)
          request.requestSteering!.append({
            steerId: "unbound-memory",
            text: STEERING,
          });
        return {
          text: JSON.stringify({ memoryCandidates: [FRESH_CANDIDATE] }),
          meta: {},
        };
      }
      return { text: "Fresh answer.", meta: {} };
    });
    const { request } = createHarness(invoke);
    await expect(
      runSupervisorAuthoredResponse(request, {
        ...BOUND_OPTIONS,
        responseRecommendation,
        steeringSnapshot,
      }),
    ).resolves.toEqual({
      finalResponse: "Fresh answer.",
      memoryCandidates: [FRESH_CANDIDATE],
    });
    expect(invoke.mock.calls.map(([input]) => invocationPhase(input))).toEqual([
      "memory",
      "memory",
      "response",
    ]);
  },
);

test.each([false, true])(
  "preserves memory-error isolation and primary abort, aborted=%j",
  async (abortRequest) => {
    const memoryError = new Error("Memory authoring unavailable.");
    const abortReason = new Error("Primary request cancelled.");
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (invocationPhase(input) === "memory") {
        assertMemoryInput(input);
        if (abortRequest) abortController.abort(abortReason);
        throw memoryError;
      }
      return { text: "Answer without memory candidates.", meta: {} };
    });
    const { request, abortController } = createHarness(invoke);
    const result = runSupervisorAuthoredResponse(request, BOUND_OPTIONS);
    if (abortRequest) {
      await expect(result).rejects.toBe(abortReason);
      expect(invoke).toHaveBeenCalledTimes(1);
      return;
    }
    await expect(result).resolves.toEqual({
      finalResponse: "Answer without memory candidates.",
      memoryCandidates: [],
    });
    expect(invoke.mock.calls.map(([input]) => invocationPhase(input))).toEqual([
      "memory",
      "response",
    ]);
  },
);
