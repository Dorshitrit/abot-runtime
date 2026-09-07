import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
import { directRespondDecision } from "./support/supervisor-direct-respond.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];

function createRequest(invoke: ModelGatewayClient["invoke"]) {
  return createTestRequestExecutionScope({
    requestId: "direct-recommendation-request",
    sessionId: "direct-recommendation-session",
    prompt: "Explain the distinction in the previous message.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    requestSteering: createRequestSteeringInbox({
      requestId: "direct-recommendation-request",
    }),
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
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
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: vi.fn(() => []),
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}

function readRecommendation(input: ModelInput): string {
  const messages = input.messages as readonly {
    role: string;
    content: string;
  }[];
  const capsules = messages.flatMap((message) => {
    try {
      const capsule = JSON.parse(message.content);
      return capsule.kind === SUPERVISOR_RESPONSE_RECOMMENDATION_KIND
        ? [capsule]
        : [];
    } catch {
      return [];
    }
  });
  expect(capsules).toHaveLength(1);
  expect(capsules[0]).toMatchObject({
    callId: "call-1",
    applicability: "current_direct_response_only",
  });
  expect(input).not.toHaveProperty("format");
  return capsules[0].responseRecommendation;
}

function respond(recommendation: string): string {
  return JSON.stringify({
    decision: directRespondDecision({
      responseRecommendation: recommendation,
      acknowledgement: "I will explain the distinction.",
    }),
  });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test("hands the accepted recommendation to one raw response without publishing it or invoking a child", async () => {
  const recommendation =
    "INTERNAL_RECOMMENDATION: explain that deciding chooses an action and presenting communicates its result.";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "supervisor.decision")
      return { text: respond(recommendation), meta: {} };
    expect(input.modelStep).toBe("supervisor.response");
    expect(readRecommendation(input)).toBe(recommendation);
    return {
      text: "The distinction is between deciding and presenting.",
      meta: {},
    };
  });
  const request = createRequest(invoke);
  await expect(runRequestRunner(request)).resolves.toEqual({
    output: "The distinction is between deciding and presenting.",
  });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "supervisor.decision",
    "supervisor.response",
  ]);
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
    "The distinction is between deciding and presenting.",
  );
  expect(request.onAcknowledgement).not.toHaveBeenCalled();
  expect(
    request.workerCapabilities.provider.getAdapters,
  ).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(request.onEvent).mock.calls)).not.toContain(
    recommendation,
  );
});

test("does not hand off a recommendation from a decision superseded by user steering", async () => {
  let decisionCount = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "supervisor.decision") {
      decisionCount += 1;
      if (decisionCount === 1) {
        request.requestSteering!.append({
          steerId: "new-scope",
          text: "Explain only the first point.",
        });
        return {
          text: respond(
            "Explain both coordinates as locations and directions as orientations.",
          ),
          meta: {},
        };
      }
      return {
        text: respond("Explain only that coordinates identify locations."),
        meta: {},
      };
    }
    expect(readRecommendation(input)).toBe(
      "Explain only that coordinates identify locations.",
    );
    return { text: "Only the first point.", meta: {} };
  });
  const request = createRequest(invoke);
  await expect(runRequestRunner(request)).resolves.toEqual({
    output: "Only the first point.",
  });
  expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "supervisor.decision",
    "supervisor.decision",
    "supervisor.response",
  ]);
});

test.each(["Old response.", ""])(
  "replaces the recommendation before committing a response when steering arrives during authoring: %j",
  async (staleOutput) => {
    const recommendations: string[] = [];
    let decisionCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === "supervisor.decision") {
        decisionCount += 1;
        return {
          text: respond(
            decisionCount === 1
              ? "Describe coordinates as locations and directions as orientations."
              : "In one sentence, contrast location coordinates with directional orientation.",
          ),
          meta: {},
        };
      }
      recommendations.push(readRecommendation(input));
      if (recommendations.length === 1)
        request.requestSteering!.append({
          steerId: "late-scope",
          text: "Give one sentence only.",
        });
      return {
        text: decisionCount === 1 ? staleOutput : "Updated response.",
        meta: {},
      };
    });
    const request = createRequest(invoke);
    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Updated response.",
    });
    expect(recommendations).toEqual([
      "Describe coordinates as locations and directions as orientations.",
      "In one sentence, contrast location coordinates with directional orientation.",
    ]);
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "supervisor.decision",
      "supervisor.response",
      "supervisor.decision",
      "supervisor.response",
    ]);
    expect(decisionCount).toBe(2);
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      "Updated response.",
    );
  },
);

test.each([
  { label: "missing", recommendation: undefined },
  { label: "null", recommendation: null },
  { label: "oversized", recommendation: "x".repeat(301) },
])(
  "keeps accepted respond when its recommendation is $label",
  async ({ recommendation }) => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === "supervisor.decision") {
        expect(invoke).toHaveBeenCalledTimes(1);
        return {
          text: JSON.stringify({
            decision: {
              action: "respond",
              acknowledgement: "I will explain the distinction.",
              responseRecommendation: recommendation,
            },
          }),
          meta: {},
        };
      }
      expect(input.modelStep).toBe("supervisor.response");
      expect(input).not.toHaveProperty("format");
      expect(JSON.stringify(input.messages)).not.toContain(
        SUPERVISOR_RESPONSE_RECOMMENDATION_KIND,
      );
      return { text: "The established distinction.", meta: {} };
    });
    const request = createRequest(invoke);
    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The established distinction.",
    });
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "supervisor.decision",
      "supervisor.response",
    ]);
    expect(
      request.workerCapabilities.provider.getAdapters,
    ).not.toHaveBeenCalled();
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      "The established distinction.",
    );
  },
);

test.each([
  { recommendation: undefined, steeringSnapshot: { version: 0, updates: [] } },
  {
    recommendation: "Explain the established distinction.",
    steeringSnapshot: undefined,
  },
])(
  "preserves unbound response retries without both recommendation and steering snapshot: %j",
  async ({ recommendation, steeringSnapshot }) => {
    let responseCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      expect(input.modelStep).toBe("supervisor.response");
      responseCount += 1;
      if (responseCount === 1) {
        request.requestSteering!.append({
          steerId: "unbound-update",
          text: "Keep it brief.",
        });
      }
      return {
        text: responseCount === 1 ? "Old response." : "Updated response.",
        meta: {},
      };
    });
    const request = createRequest(invoke);
    await expect(
      runSupervisorAuthoredResponse(request, {
        call: {
          rootCallId: "call-1",
          callId: "call-1",
          parentCallId: null,
          depth: 0,
          invocationAttempt: 1,
        },
        toolResults: { sourceRevision: 1, results: [] },
        responseRecommendation: recommendation,
        steeringSnapshot,
      }),
    ).resolves.toEqual({
      finalResponse: "Updated response.",
      memoryCandidates: [],
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  },
);

test("returns a stale recommendation binding before invoking the response provider", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const request = createRequest(invoke);
  request.requestSteering!.append({
    steerId: "before-authoring",
    text: "Explain only the first point.",
  });
  await expect(
    runSupervisorAuthoredResponse(request, {
      call: {
        rootCallId: "call-1",
        callId: "call-1",
        parentCallId: null,
        depth: 0,
        invocationAttempt: 1,
      },
      toolResults: { sourceRevision: 1, results: [] },
      responseRecommendation: "Explain both points.",
      steeringSnapshot: { version: 0, updates: [] },
    }),
  ).rejects.toMatchObject({
    name: "ModelStepSteeringSupersededError",
    boundSteeringVersion: 0,
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(request.onThinkingTrace).not.toHaveBeenCalled();
});
