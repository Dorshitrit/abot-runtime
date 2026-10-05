import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createSuperFailureFinalization } from "../request/super-failure-explanation.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import {
  createRootInvalidOutputRequest,
  INVALID_OUTPUT_RUNNER_CONFIG,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});
const input = {
  problem: { stage: "decide", code: "primary_failure" },
  progress: null,
};
const failure = new Error("primary_failure");
const fallback = buildDegradedFinalizationFallback(input);
const phrasing = {
  failureNotice: "לא הצלחתי לסיים.",
  nextStep: "אפשר להמשיך בהודעה חדשה.",
};

function explain(
  request: ReturnType<typeof createRootInvalidOutputRequest>,
  limit = 1000,
) {
  return request.superFailureFinalization!.explain({
    error: failure,
    input,
    maxResponseChars: limit,
  });
}

test.each(["invalid", "incomplete", "provider", "timeout"] as const)(
  "SUPER %s finalizer selects a complete fallback after one attempt",
  async (scenario) => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (modelInput) => {
      if (scenario === "provider") throw new Error("secondary_failure");
      if (scenario === "timeout")
        return new Promise((_resolve, reject) => {
          modelInput.abortSignal.addEventListener(
            "abort",
            () => reject(modelInput.abortSignal.reason),
            { once: true },
          );
        });
      return {
        text: "invalid",
        meta:
          scenario === "incomplete"
            ? { providerCompletionReason: "length" }
            : {},
      };
    });
    const request = createRootInvalidOutputRequest(
      invoke,
      "supervisor-worker-v1",
      {
        runnerConfig: {
          ...INVALID_OUTPUT_RUNNER_CONFIG,
          steps: {
            ...INVALID_OUTPUT_RUNNER_CONFIG.steps,
            "degraded.finalization": { timeoutMs: 5 },
          },
        },
      },
    );
    expect(await explain(request)).toMatchObject({
      output: fallback,
      source: "runtime_fallback",
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(request.superFailureFinalization!.primaryError()).toBe(failure);
  },
);

test("missing finalizer config consumes the cached attempt without inference", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    {
      runnerConfig: { ...INVALID_OUTPUT_RUNNER_CONFIG, steps: {} },
    },
  );
  expect(await explain(request)).toMatchObject({
    output: fallback,
    source: "runtime_fallback",
  });
  expect(await explain(request)).toMatchObject({ output: fallback });
  expect(invoke).not.toHaveBeenCalled();
});

test.each(["disabled", "expired", "aborted"] as const)(
  "%s request budget never creates fresh time",
  async (state) => {
    const abort = new AbortController();
    if (state === "aborted") abort.abort(new Error("request_cancelled"));
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: JSON.stringify(phrasing),
      meta: {},
    }));
    const request = createRootInvalidOutputRequest(
      invoke,
      "supervisor-worker-v1",
      { abortSignal: abort.signal },
    );
    const owner = createSuperFailureFinalization({
      request,
      executionPolicy: request.executionPolicy,
      readBudgets: () => ({
        requestTimeoutMs: state === "expired" ? 100 : 0,
        requestRemainingMs: 0,
        inactivityTimeoutMs: 0,
        inactivityRemainingMs: 0,
      }),
    })!;
    const result = await owner.explain({
      error: failure,
      input,
      maxResponseChars: 1000,
    });
    expect(result.source).toBe(
      state === "disabled" ? "model" : "runtime_fallback",
    );
    expect(invoke).toHaveBeenCalledTimes(state === "disabled" ? 1 : 0);
  },
);

test("large progress is dropped before bounded authored language; no partial text is cut", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify(phrasing),
    meta: {},
  }));
  const request = createRootInvalidOutputRequest(invoke);
  const result = await request.superFailureFinalization!.explain({
    error: failure,
    input: {
      ...input,
      progress: {
        planSummary: "Recorded work",
        completed: [{ id: "done", title: "LONG_PROGRESS".repeat(200) }],
        unresolved: [],
      },
    },
    maxResponseChars: 300,
  });
  expect(result).toMatchObject({
    output: `${phrasing.failureNotice}\n\n${phrasing.nextStep}`,
    source: "model",
  });
  expect(result.output.length).toBeLessThanOrEqual(300);
  expect(JSON.stringify(invoke.mock.calls[0]![0].messages)).not.toContain(
    "LONG_PROGRESS",
  );
});

test("oversized authored prose selects the complete bounded fallback without a repair", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify({ ...phrasing, failureNotice: "ארוך".repeat(1000) }),
    meta: {},
  }));
  const request = createRootInvalidOutputRequest(invoke);
  expect(await explain(request, 300)).toMatchObject({
    output: fallback,
    source: "runtime_fallback",
    secondaryCode: "degraded_finalization_response_too_long",
  });
  expect(invoke).toHaveBeenCalledOnce();
});

test("memoized explanation is shared by root and outer delivery without source or context leakage", async () => {
  const steering = createRequestSteeringInbox({
    requestId: "root-invalid-request",
  });
  steering.append({ steerId: "latest", text: "ענה לי בעברית בבקשה" });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify(phrasing),
    meta: {},
  }));
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    {
      requestSteering: steering,
      historyMessages: [
        {
          id: "history",
          createdAt: "2026-10-01T00:00:00Z",
          role: "user",
          content: "PRIVATE_HISTORY",
        },
      ],
    },
  );
  const first = await explain(request);
  const outer = await request.superFailureFinalization!.explain({
    error: new Error("delivery_secondary"),
    input,
    maxResponseChars: 10000,
  });
  expect(outer).toBe(first);
  expect(invoke).toHaveBeenCalledOnce();
  expect(request.superFailureFinalization!.primaryError()).toBe(failure);
  const modelInput = JSON.stringify(invoke.mock.calls[0]![0].messages);
  expect(modelInput).toContain("ענה לי בעברית בבקשה");
  expect(modelInput).not.toContain("PRIVATE_HISTORY");
  expect(modelInput).not.toContain("delivery_secondary");
  expect(
    Object.getOwnPropertyDescriptor(request, "superFailureFinalization")
      ?.enumerable,
  ).toBe(false);
  expect(request.workerCapabilities.executionContext).not.toHaveProperty(
    "superFailureFinalization",
  );
});

test("admission failure is contained without a provider request", async () => {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const request = createRootInvalidOutputRequest(
    invoke,
    "supervisor-worker-v1",
    {
      modelPolicy: {
        providers: { test: { type: "ollama" } },
        profiles: {
          "invalid-output-test": {
            provider: "test",
            model: "test",
            contextWindowTokens: 128,
          },
        },
        defaults: INVALID_OUTPUT_RUNNER_CONFIG.models.defaults,
      },
    },
  );
  expect(await explain(request)).toMatchObject({
    output: fallback,
    source: "runtime_fallback",
  });
  expect(invoke).not.toHaveBeenCalled();
});
