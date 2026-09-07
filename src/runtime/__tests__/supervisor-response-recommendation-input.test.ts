import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestToolResultsView } from "../context/request-tool-results.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  buildSupervisorDecisionInput,
  type SupervisorDecisionInputRequest,
} from "../steps/supervisor-decision/input.js";
import {
  buildSupervisorMemoryAuthoringInput,
  buildSupervisorResponseInput,
} from "../steps/supervisor-response/input.js";
import { SUPERVISOR_RESPONSE_RECOMMENDATION_KIND } from "../steps/supervisor-response/response-recommendation.js";

const CURRENT_PROMPT = "Explain the distinction from the information above.";
const RESPONSE_RECOMMENDATION =
  "Explain that coordinates identify locations, whereas directions describe orientations.";
const request = {
  requestId: "response-recommendation-request",
  prompt: CURRENT_PROMPT,
  historyMessages: [
    {
      id: "history-user",
      role: "user",
      content: "A coordinate identifies a location.",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
    {
      id: "history-assistant",
      role: "assistant",
      content: "A direction describes an orientation.",
      createdAt: "2026-09-05T00:00:01.000Z",
    },
  ],
  agentMode: "reasoning",
  shouldGenerateSessionTitle: false,
  runnerConfig: {
    models: {
      defaults: {
        profileId: "recommendation-test",
        steps: {
          "supervisor.decision": "recommendation-test",
          "supervisor.response": "recommendation-test",
        },
      },
    },
    context: {
      outputReserveTokens: 1_000,
      safetyReserveTokens: 200,
      attachmentReserveTokens: 100,
    },
    steps: {
      "supervisor.decision": { timeoutMs: 1_000 },
      "supervisor.response": { timeoutMs: 1_000 },
    },
  },
  modelPolicy: {
    providers: { test: { type: "ollama" } },
    profiles: {
      "recommendation-test": {
        provider: "test",
        model: "recommendation-test-model",
        contextWindowTokens: 8_000,
      },
    },
    defaults: { profileId: "recommendation-test" },
  },
} satisfies SupervisorDecisionInputRequest;

const EMPTY_RESULTS = {
  sourceRevision: 1,
  results: [],
} satisfies RequestToolResultsView;
const SETTLED_RESULTS = {
  sourceRevision: 3,
  results: [
    {
      executionId: "execution-1",
      callId: "call-2",
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "The requested external state was observed.",
    },
  ],
} satisfies RequestToolResultsView;
const call = {
  rootCallId: "call-1",
  callId: "call-1",
  parentCallId: null,
  depth: 0,
  invocationAttempt: 2,
};
const resume = {
  callerCallId: "call-1",
  invocationAttempt: 2,
  returnedChildCallId: "call-2",
  returnedResultRef: "result-1",
  completedChildren: [
    {
      callerCallId: "call-1",
      childCallId: "call-2",
      resultRef: "result-1",
      roleId: "worker" as const,
      objective: "Observe the requested external state.",
      workingDirectory: ".",
      dependencyResultRefs: [],
      outcome: "completed" as const,
      summary: "The requested external state was observed.",
    },
  ],
};

function isRecommendationCapsule(message: ChatMessage): boolean {
  try {
    return (
      JSON.parse(message.content).kind ===
      SUPERVISOR_RESPONSE_RECOMMENDATION_KIND
    );
  } catch {
    return false;
  }
}

function responseMessages(responseRecommendation?: string): ChatMessage[] {
  return buildSupervisorResponseInput(request, {
    call,
    toolResults: EMPTY_RESULTS,
    ...(responseRecommendation === undefined ? {} : { responseRecommendation }),
  }).context.messages;
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Supervisor response-recommendation projection", () => {
  test("requests the recommendation only before any child return or settled tool result", () => {
    const initial = buildSupervisorDecisionInput(request, {
      toolResults: EMPTY_RESULTS,
    });
    const afterEffect = buildSupervisorDecisionInput(request, {
      toolResults: SETTLED_RESULTS,
    });
    const afterChild = buildSupervisorDecisionInput(request, {
      toolResults: EMPTY_RESULTS,
      resume,
      diagnostic: {
        requestId: request.requestId,
        modelStep: "supervisor.decision",
        ...call,
      },
    });
    expect(initial.includeResponseRecommendation).toBe(true);
    expect(afterEffect.includeResponseRecommendation).toBe(false);
    expect(afterChild.includeResponseRecommendation).toBe(false);
  });

  test("adds one passive reference bound to this call without adding user intent", () => {
    const baseline = responseMessages();
    const projected = responseMessages(RESPONSE_RECOMMENDATION);
    const capsules = projected.filter(isRecommendationCapsule);
    expect(capsules).toHaveLength(1);
    expect(capsules[0].role).toBe("system");
    expect(JSON.parse(capsules[0].content)).toMatchObject({
      kind: SUPERVISOR_RESPONSE_RECOMMENDATION_KIND,
      authority: "accepted_supervisor_decision",
      purpose: "guide_direct_response_content",
      applicability: "current_direct_response_only",
      callId: call.callId,
      invocationAttempt: call.invocationAttempt,
      responseRecommendation: RESPONSE_RECOMMENDATION,
      limitations: expect.any(String),
    });
    expect(projected.filter((message) => message.role === "user")).toEqual(
      baseline.filter((message) => message.role === "user"),
    );
    expect(projected.filter((message) => message.role !== "system")).toEqual(
      baseline.filter((message) => message.role !== "system"),
    );
    expect(
      projected.filter(
        (message) =>
          message.role === "user" && message.content === CURRENT_PROMPT,
      ),
    ).toHaveLength(1);
    expect(projected.at(-1)).toEqual({ role: "user", content: CURRENT_PROMPT });
  });

  test("omitting the recommendation preserves response messages and history selection", () => {
    const baseline = buildSupervisorResponseInput(request, {
      call,
      toolResults: EMPTY_RESULTS,
    });
    const omitted = buildSupervisorResponseInput(request, {
      call,
      toolResults: EMPTY_RESULTS,
      responseRecommendation: undefined,
    });
    expect(omitted.context.messages).toEqual(baseline.context.messages);
    expect(omitted.context.selectedHistoryMessageIds).toEqual(
      baseline.context.selectedHistoryMessageIds,
    );
    expect(omitted.context.messages.some(isRecommendationCapsule)).toBe(false);
  });

  test("keeps the recommendation out of memory-candidate authoring", () => {
    const baseline = buildSupervisorMemoryAuthoringInput(request, {
      call,
      toolResults: EMPTY_RESULTS,
    });
    const withReason = buildSupervisorMemoryAuthoringInput(request, {
      call,
      toolResults: EMPTY_RESULTS,
      responseRecommendation: RESPONSE_RECOMMENDATION,
    });
    expect(withReason.context.messages).toEqual(baseline.context.messages);
    expect(withReason.context.messages.some(isRecommendationCapsule)).toBe(
      false,
    );
    expect(
      withReason.context.messages.some((message) =>
        message.content.includes(RESPONSE_RECOMMENDATION),
      ),
    ).toBe(false);
  });

  test("preserves a recommendation at the exact character budget", () => {
    const responseRecommendation = "x".repeat(300);
    const capsule = responseMessages(responseRecommendation).find(
      isRecommendationCapsule,
    );
    expect(capsule).toBeDefined();
    expect(JSON.parse(capsule!.content).responseRecommendation).toBe(
      responseRecommendation,
    );
  });

  test.each(["", "   ", "x".repeat(301)])(
    "rejects an invalid supplied recommendation: %j",
    (responseRecommendation) => {
      expect(() => responseMessages(responseRecommendation)).toThrow(
        "supervisor_response_recommendation_invalid",
      );
    },
  );

  test.each([
    { toolResults: EMPTY_RESULTS, resume },
    { toolResults: SETTLED_RESULTS },
  ])(
    "rejects a supplied recommendation after a child return or tool evidence",
    (options) => {
      expect(() =>
        buildSupervisorResponseInput(request, {
          call,
          ...options,
          responseRecommendation: RESPONSE_RECOMMENDATION,
        }),
      ).toThrow("supervisor_response_recommendation_scope_invalid");
    },
  );
});
