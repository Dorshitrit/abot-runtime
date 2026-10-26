import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { generateSemanticCompactionCandidateBatched } from "../context/semantic-compaction/run.js";
import { invokeModelStep } from "../model/invoke-step.js";
import {
  MODEL_STEP_TIMED_OUT_EVENT,
  projectModelStepTimeoutEvent,
} from "../model/model-step-timeout-event.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";

beforeEach(() => {
  configureDebugLogger({ enabled: false });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  resetDebugLoggerConfig();
});

function startStep(
  invoke: ModelGatewayClient["invoke"],
  options: {
    modelStep?: ModelStep;
    parent?: AbortController;
    modelPolicy?: ModelGatewayPolicyConfig;
  } = {},
) {
  const modelStep = options.modelStep ?? "tool_payload.raw";
  const initial = createInvalidOutputRequest(invoke);
  const onEvent = vi.fn();
  const parent = options.parent ?? new AbortController();
  const request = deriveTestRequestExecutionScope(initial, {
    onEvent,
    abortSignal: parent.signal,
    modelPolicy: options.modelPolicy ?? {
      ...initial.modelPolicy,
      defaults: { profileId: "test", steps: { [modelStep]: "configured.slot" } },
    },
    runnerConfig: {
      ...initial.runnerConfig,
      steps: { ...initial.runnerConfig.steps, [modelStep]: { timeoutMs: 5 } },
    },
  });
  const accept = vi.fn((text: string) => text);
  const result = invokeModelStep({
    request, modelStep,
    messages: [{ role: "user", content: "Return the bounded result." }],
    timeoutReason: "owned_step_timeout",
    accept,
  });
  const events = () => onEvent.mock.calls
    .filter(([name]) => name === MODEL_STEP_TIMED_OUT_EVENT)
    .map(([, payload]) => payload);
  return { result, accept, events, request, parent };
}

function abortingProvider(settlement: "reject" | "late_response" = "reject") {
  return vi.fn<ModelGatewayClient["invoke"]>((input) => new Promise((resolve, reject) => {
    input.abortSignal.addEventListener("abort", () => {
      if (settlement === "reject") reject(new DOMException("Provider aborted", "AbortError"));
      else resolve({ text: "Late response", meta: {} });
    }, { once: true });
  }));
}

describe("model step timeout lifecycle event", () => {
  test.each([
    ["tool_payload.raw", "reject"], ["tool_payload.raw", "late_response"],
    ["execution.decision", "reject"], ["supervisor.decision", "late_response"],
    ["worker.result", "reject"], ["context.compact", "reject"],
  ] as const)("emits one owned event for %s with provider %s", async (modelStep, settlement) => {
    const invoke = abortingProvider(settlement);
    const run = startStep(invoke, { modelStep });
    const expected = expect(run.result).rejects.toMatchObject({ name: "ModelStepTimeoutError", modelStep });
    await vi.advanceTimersByTimeAsync(5);
    await expected;
    expect(run.events()).toEqual([{
      requestId: run.request.requestId,
      invocationId: expect.any(String),
      modelStep,
      timeoutMs: 5,
      configuredTimeoutMs: 5,
      timeoutSource: "runner",
      configurationProfileId: "test",
      calibrationSlotId: "configured.slot",
      profileId: "test",
      model: "test",
      provider: "ollama",
    }]);
    expect(run.events()[0].invocationId.length).toBeGreaterThan(0);
    expect(invoke).toHaveBeenCalledOnce();
    expect(run.accept).not.toHaveBeenCalled();
    expect(run.parent.signal.aborted).toBe(false);
  });

  test("retains the timeout owner when calibration selects a different model", async () => {
    const run = startStep(abortingProvider(), { modelPolicy: {
      providers: { local: { type: "ollama" }, alternate: { type: "ollama" } },
      profiles: {
        test: {
          provider: "local", model: "test", contextWindowTokens: 64_000,
          calibration: { "configured.slot": { timeoutMs: 10, profileId: "writer" } },
        },
        writer: { provider: "alternate", model: "writer-model", contextWindowTokens: 64_000 },
      },
      defaults: { profileId: "test", steps: { "tool_payload.raw": "configured.slot" } },
    } });
    const expected = expect(run.result).rejects.toBeInstanceOf(ModelStepTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    expect(run.events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    await expected;
    expect(run.events()).toEqual([expect.objectContaining({
      timeoutMs: 10, configuredTimeoutMs: 5, timeoutSource: "model_calibration",
      configurationProfileId: "test", calibrationSlotId: "configured.slot",
      profileId: "writer", provider: "ollama", model: "writer-model",
    })]);
  });

  test.each(["profile", "invocation"] as const)("does not advertise a calibration slot for a direct %s mapping", async (selection) => {
    const profile = { provider: "local", model: "test", contextWindowTokens: 64_000 };
    const run = startStep(abortingProvider(), { modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: { test: profile, ...(selection === "profile" ? { direct: profile } : {}) },
      ...(selection === "invocation" ? { invocationProfiles: { direct: { profileId: "test" } } } : {}),
      defaults: { profileId: "test", steps: { "tool_payload.raw": "direct" } },
    } });
    const expected = expect(run.result).rejects.toBeInstanceOf(ModelStepTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await expected;
    expect(run.events()).toHaveLength(1);
    expect(run.events()[0]).not.toHaveProperty("calibrationSlotId");
  });

  test.each(["request_cancelled", "request_timeout"])("does not emit when %s supersedes the local deadline", async (reason) => {
    const parent = new AbortController();
    const failure = new Error(reason);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>((input) => new Promise((_, reject) => {
      input.abortSignal.addEventListener("abort", () => {
        parent.abort(failure);
        reject(input.abortSignal.reason);
      }, { once: true });
    }));
    const run = startStep(invoke, { parent });
    const expected = expect(run.result).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(5);
    await expected;
    expect(run.events()).toEqual([]);
    expect(run.accept).not.toHaveBeenCalled();
  });

  test.each([new Error("owned_step_timeout"), new ModelStepTimeoutError("provider_timeout", "tool_payload.raw")])(
    "does not infer a local deadline from provider error %s", async (failure) => {
      const run = startStep(vi.fn(async () => { throw failure; }));
      await expect(run.result).rejects.toBe(failure);
      expect(run.events()).toEqual([]);
    },
  );

  test("leaves successful response handling unchanged", async () => {
    const run = startStep(vi.fn(async () => ({ text: "Complete", meta: {} })));
    await expect(run.result).resolves.toBe("Complete");
    await vi.advanceTimersByTimeAsync(10);
    expect(run.accept).toHaveBeenCalledOnce();
    expect(run.events()).toEqual([]);
  });

  test("does not project another step's abort reason", () => {
    const attempt = new AbortController();
    attempt.abort(new ModelStepTimeoutError("context_compaction_timeout", "context.compact"));
    expect(projectModelStepTimeoutEvent({
      requestId: "request", modelStep: "execution.decision",
      identity: { invocationId: "attempt", profileId: "test", provider: "local", model: "test" },
      parentSignal: new AbortController().signal, attemptSignal: attempt.signal,
      configuredTimeoutMs: 5, timeout: { timeoutMs: 5, source: "runner" },
    })).toBeUndefined();
  });

  test.each([
    ["execution-agent-v1", false], ["execution-agent-v1", true],
    ["supervisor-worker-v1", false], ["supervisor-worker-v1", true],
  ] as const)("attributes %s compaction timeout to its own invocation (sliced=%s)", async (policy, sliced) => {
    const fixture = semanticContractFixture({ policy, sliced });
    fixture.invoke.mockImplementation(abortingProvider());
    const result = generateSemanticCompactionCandidateBatched(fixture.params);
    const expected = expect(result).rejects.toMatchObject({ modelStep: "context.compact", name: "ModelStepTimeoutError" });
    await vi.advanceTimersByTimeAsync(20_000);
    await expected;
    const request = fixture.params.request as ReturnType<typeof createInvalidOutputRequest>;
    const events = vi.mocked(request.onEvent).mock.calls
      .filter(([name]) => name === MODEL_STEP_TIMED_OUT_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({
      modelStep: "context.compact", profileId: "contract-model",
      configurationProfileId: "contract-model", calibrationSlotId: "context.compact",
      timeoutMs: 20_000, configuredTimeoutMs: 20_000, timeoutSource: "runner",
    });
    expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
    expect(fixture.params.request.abortSignal.aborted).toBe(false);
    expect(fixture.invoke).toHaveBeenCalledOnce();
  });
});
