import { describe, expect, test, vi } from "vitest";

import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import {
  createTestRequestExecutionScope,
  type TestRequestSeed,
} from "./support/request-execution-scope.js";
import type { DegradedFinalizationInput } from "../steps/degraded-finalization/contract.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import { renderDegradedFinalization } from "../steps/degraded-finalization/render.js";
import { runDegradedFinalization } from "../steps/degraded-finalization/run.js";

const degradedStep = MODEL_STEPS.DEGRADED_FINALIZATION;
const invokedSteps = [
  MODEL_STEPS.SUPERVISOR_DECISION,
  MODEL_STEPS.SUPERVISOR_RESPONSE,
  MODEL_STEPS.WORKER_DECISION,
  MODEL_STEPS.PLANNER_DECISION,
  MODEL_STEPS.REVIEWER_DECISION,
  degradedStep,
  MODEL_STEPS.TOOL_PAYLOAD_RAW,
] as const;

const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runtime-test",
      steps: Object.fromEntries(invokedSteps.map((stepId) => [stepId, stepId])),
    },
  },
  context: {
    outputReserveTokens: 1_500,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: Object.fromEntries(
    invokedSteps.map((stepId) => [stepId, { timeoutMs: 20_000 }]),
  ),
};

const input: DegradedFinalizationInput = {
  problem: {
    stage: "worker.decision",
    code: "decision_repair_exhausted",
  },
  progress: {
    planSummary: "Apply the requested change.",
    completed: [{ id: "setup", title: "Verified setup" }],
    unresolved: [
      {
        id: "integration",
        title: "Pending integration",
        status: "in_progress",
      },
    ],
  },
};

describe("runtime degraded finalization", () => {
  test("uses one structured model invocation while the runtime renders canonical work facts", async () => {
    const phrasing = {
      failureNotice: "I could not safely finish this request.",
      nextStep: "Continue from the saved session in a follow-up request.",
    };
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (params) => {
      params.onThinking?.("Writing neutral framing.");
      return { text: JSON.stringify(phrasing), meta: {} };
    });
    const request = createRequest(invoke);

    await expect(runDegradedFinalization({ request, input })).resolves.toBe(
      renderDegradedFinalization({ input, phrasing }),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    const invocation = invoke.mock.calls[0]![0];
    expect(invocation).toMatchObject({
      modelStep: degradedStep,
      agentMode: "reasoning",
      debugRequestId: "req-degraded-finalization",
      format: {
        type: "json_schema",
        name: "degraded_finalization",
        strict: true,
      },
    });
    const modelInput = (
      invocation.messages as readonly Readonly<{ content: string }>[]
    )
      .map((message) => message.content)
      .join("\n");
    expect(modelInput).toContain('"code": "decision_repair_exhausted"');
    expect(modelInput).not.toContain("Verified setup");
    expect(modelInput).not.toContain("Pending integration");
    expect(request.onThinkingDelta).toHaveBeenCalledWith(
      "Writing neutral framing.",
    );
    expect(request.onThinkingTrace).toHaveBeenCalledWith({
      step: degradedStep,
      status: "completed",
      text: "Writing neutral framing.",
    });
  });

  test("keeps runtime-owned progress rendering language-neutral for a Hebrew response", async () => {
    const hebrewInput: DegradedFinalizationInput = {
      problem: {
        stage: "worker.decision",
        code: "role_turn_limit",
      },
      progress: {
        planSummary: "השלמת השינוי המבוקש",
        completed: [{ id: "setup", title: "הכנת סביבת העבודה" }],
        unresolved: [
          {
            id: "verification",
            title: "אימות התוצאה",
            status: "in_progress",
          },
        ],
      },
    };
    const phrasing = {
      failureNotice: "לא ניתן היה להשלים את הבקשה בבטחה.",
      nextStep: "אפשר להמשיך מהמצב הקיים בהודעה הבאה.",
    };
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: JSON.stringify(phrasing),
      meta: {},
    }));
    const request = createRequest(invoke, {
      prompt: "בצע את השינוי ובדוק את התוצאה.",
    });

    const answer = await runDegradedFinalization({
      request,
      input: hebrewInput,
    });

    expect(answer).toContain("### השלמת השינוי המבוקש");
    expect(answer).toContain("- [x] הכנת סביבת העבודה");
    expect(answer).toContain("- [-] אימות התוצאה");
    expect(answer).not.toMatch(
      /Canonical progress state|Plan:|Confirmed completed work|Unresolved work|none/u,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    const modelInput = (
      invoke.mock.calls[0]![0].messages as readonly Readonly<{
        content: string;
      }>[]
    )
      .map((message) => message.content)
      .join("\n");
    expect(modelInput).toContain("בצע את השינוי ובדוק את התוצאה.");
    expect(modelInput).toContain(
      "Use exactly the same language as the user's last message.",
    );
  });

  test.each([
    {
      name: "model gateway failure",
      invoke: async () => {
        throw new Error("gateway_unavailable");
      },
    },
    {
      name: "empty model output",
      invoke: async () => ({ text: "   ", meta: {} }),
    },
    {
      name: "non-empty malformed JSON",
      invoke: async () => ({ text: "not-json", meta: {} }),
    },
    {
      name: "output with an extra field",
      invoke: async () => ({
        text: JSON.stringify({
          failureNotice: "The runtime stopped.",
          nextStep: "Continue later.",
          completed: ["invented work"],
        }),
        meta: {},
      }),
    },
    {
      name: "valid-looking output stopped at the provider limit",
      invoke: async () => ({
        text: JSON.stringify({
          failureNotice: "This partial phrasing must not be sent.",
          nextStep: "This partial phrasing must not be sent.",
        }),
        meta: { providerCompletionReason: "max_output_tokens" },
      }),
    },
  ])(
    "returns the deterministic canonical fallback without retry after $name",
    async ({ invoke: invokeImplementation }) => {
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(invokeImplementation);
      const request = createRequest(invoke);

      await expect(runDegradedFinalization({ request, input })).resolves.toBe(
        buildDegradedFinalizationFallback(input),
      );

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]![0]).toMatchObject({
        modelStep: degradedStep,
        format: {
          type: "json_schema",
          name: "degraded_finalization",
        },
      });
    },
  );

  test("uses the deterministic fallback when the single degraded call times out", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(
      async (params) =>
        new Promise((_, reject) => {
          params.abortSignal.addEventListener(
            "abort",
            () => reject(params.abortSignal.reason),
            { once: true },
          );
        }),
    );
    const request = createRequest(invoke, {
      runnerConfig: {
        ...runnerConfig,
        steps: { [degradedStep]: { timeoutMs: 5 } },
      },
    });

    await expect(runDegradedFinalization({ request, input })).resolves.toBe(
      buildDegradedFinalizationFallback(input),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(request.onThinkingTrace).toHaveBeenCalledWith({
      step: degradedStep,
      status: "timeout",
      text: "",
    });
  });

  test("propagates a parent abort even when the degraded model call later resolves", async () => {
    const abortController = new AbortController();
    let releaseModel!: () => void;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
      await new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      return {
        text: JSON.stringify({
          failureNotice: "This must not be returned.",
          nextStep: "This must not be returned.",
        }),
        meta: {},
      };
    });
    const request = createRequest(invoke, {
      abortSignal: abortController.signal,
    });

    const result = runDegradedFinalization({ request, input });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    abortController.abort(new Error("request_aborted_during_degraded"));
    releaseModel();

    await expect(result).rejects.toThrow("request_aborted_during_degraded");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

function createRequest(
  invoke: ModelGatewayClient["invoke"],
  overrides: Partial<TestRequestSeed> = {},
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId: "req-degraded-finalization",
    sessionId: "session-degraded-finalization",
    prompt: "Apply the requested change.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig,
    agentMode: "reasoning",
    modelPolicy: {
      providers: { test: { type: "ollama" } },
      profiles: {
        "runtime-test": {
          provider: "test",
          model: "runtime-test-model",
          contextWindowTokens: 12_000,
        },
      },
      defaults: {
        profileId: "runtime-test",
        steps: Object.fromEntries(
          invokedSteps.map((stepId) => [stepId, stepId]),
        ),
      },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
    ...overrides,
  });
}
