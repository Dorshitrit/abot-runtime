import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { ProviderContextOverflowError } from "../../model-gateway/protocol/provider-context-overflow.js";
import { ProviderStreamDisconnectionError } from "../../model-gateway/protocol/provider-stream-disconnection.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import { traceDebug } from "../observability/debug-logger.js";
import {
  ADMISSION_MESSAGES, createAdmissionController, createAdmissionFixture, createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

vi.mock("../observability/debug-logger.js", () => ({
  traceDebug: vi.fn(), configureDebugLogger: vi.fn(), resetDebugLoggerConfig: vi.fn(),
}));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

function disconnected() {
  return new ModelGatewayInvocationError("stream", "provider stream ended", {
    cause: new ProviderStreamDisconnectionError(),
  });
}

function streamFixture(modelStep: "execution.decision" | "supervisor.decision" = "execution.decision") {
  const fixture = createAdmissionFixture({ modelStep, counts: [1_000] });
  const accept = vi.fn((text: string) => text);
  const input = {
    modelStep, messages: ADMISSION_MESSAGES,
    timeoutReason: "stream_recovery_timeout", accept,
  };
  return { ...fixture, accept, input, start: () => fixture.invoker.invoke(input) };
}

test("an uninterrupted step retains one provider call and one acceptance", async () => {
  const f = streamFixture();
  await expect(f.start()).resolves.toBe("ok");
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).toHaveBeenCalledOnce();
  expect(traceDebug).not.toHaveBeenCalledWith("runtime.model", "provider_stream.retry_started", expect.anything());
});

test("a disconnected call retries once with the same input and deadline before accepting", async () => {
  const f = streamFixture();
  f.invoke.mockRejectedValueOnce(disconnected());
  const result = f.start();
  await vi.advanceTimersByTimeAsync(249);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe("ok");
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.countInputTokens).toHaveBeenCalledOnce();
  const first = f.invoke.mock.calls[0]![0];
  const second = f.invoke.mock.calls[1]![0];
  expect(second.messages).toBe(first.messages);
  expect(second.abortSignal).toBe(first.abortSignal);
  expect(second.modelPolicy).toBe(first.modelPolicy);
  expect(second.format).toBe(first.format);
  expect(second.debugRequestId).toBe(first.debugRequestId);
  expect(traceDebug).not.toHaveBeenCalledWith("runtime.model", "step.failed", expect.anything());
});

test("a second disconnect fails without accepting output or adding a third call", async () => {
  const f = streamFixture();
  f.invoke.mockRejectedValue(disconnected());
  const result = f.start().catch(error => error);
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toMatchObject({ name: "ModelProviderFailure", stage: "model_provider_stream" });
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.accept).not.toHaveBeenCalled();
});

test.each([
  new Error("provider stream ended"),
  new TypeError("local callback failed"),
  new ModelGatewayInvocationError("network", "gateway connection lost"),
  new ModelGatewayInvocationError("stream", "provider refused output"),
  new ModelGatewayInvocationError("inactivity", "llm_stream_inactivity_timeout"),
])("unclassified failures do not retry: %s", async (failure) => {
  const f = streamFixture();
  f.invoke.mockRejectedValue(failure);
  await expect(f.start()).rejects.toThrow(failure.message);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();
});

test("a typed error from output acceptance never replays the successful provider call", async () => {
  const f = streamFixture();
  const failure = disconnected();
  f.accept.mockImplementation(() => { throw failure; });
  await expect(f.start()).rejects.toBe(failure);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).toHaveBeenCalledOnce();
});

test("user cancellation during the delay takes precedence and prevents redispatch", async () => {
  const f = streamFixture();
  f.invoke.mockRejectedValueOnce(disconnected());
  const result = f.start().catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  const cancellation = new Error("request_cancelled");
  f.abort.abort(cancellation);
  expect(await result).toBe(cancellation);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();
});

test("the original step deadline can expire during the retry delay", async () => {
  const f = streamFixture();
  f.request.runnerConfig.steps["execution.decision"] = { timeoutMs: 100 };
  f.invoke.mockRejectedValueOnce(disconnected());
  const result = f.start().catch(error => error);
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toMatchObject({ name: "ModelStepTimeoutError", code: "stream_recovery_timeout" });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();
});

test("the replacement call has only the time remaining from the first call", async () => {
  const f = streamFixture();
  f.request.runnerConfig.steps["execution.decision"] = { timeoutMs: 500 };
  f.invoke.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 200));
    throw disconnected();
  }).mockImplementationOnce(input => new Promise((_, reject) => {
    input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason), { once: true });
  }));
  const result = f.start().catch(error => error);
  await vi.advanceTimersByTimeAsync(450);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({ name: "ModelStepTimeoutError", code: "stream_recovery_timeout" });
  expect(f.accept).not.toHaveBeenCalled();
});

test("bound steering changing during delay prevents dispatch of the old decision", async () => {
  const f = streamFixture();
  f.invoke.mockRejectedValueOnce(disconnected());
  const result = f.invoker.invoke({ ...f.input, boundSteeringVersion: 0 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  f.steering.append({ steerId: "new", text: "Use the updated direction." });
  await vi.advanceTimersByTimeAsync(150);
  expect(await result).toBeInstanceOf(ModelStepSteeringSupersededError);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();
});

test("root supersession reprojects current direction without replenishing the retry allowance", async () => {
  const f = streamFixture("supervisor.decision");
  f.invoke.mockRejectedValue(disconnected());
  const result = f.start().catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  f.steering.append({ steerId: "new", text: "Use the updated direction." });
  await vi.advanceTimersByTimeAsync(150);
  expect(await result).toMatchObject({ name: "ModelProviderFailure" });
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.invoke.mock.calls[1]![0].messages)).toContain("Use the updated direction.");
  expect(f.accept).not.toHaveBeenCalled();
});

test("context recovery cannot replenish a consumed stream retry allowance", async () => {
  const f = createAdmissionFixture({ modelStep: "execution.decision", counts: [10_000, 6_000] });
  const original: ChatMessage[] = [...ADMISSION_MESSAGES, {
    role: "tool", toolCallId: "observed", toolName: "read", content: "Evidence. ".repeat(100),
  }];
  const compacted: ChatMessage[] = [...ADMISSION_MESSAGES, { role: "system", content: "Bound evidence summary." }];
  const stage = createAdmissionStage("active_request", "summary");
  stage.prepare.mockResolvedValue({ kind: "prepared", preparation: {
    messages: compacted, scopeId: stage.scopeId, sourceRevision: 1,
    coveredSourceCount: 1, hasExhaustedCompactionSources: true, commit: stage.commit,
  } });
  const overflow = new ModelGatewayInvocationError("http", "context overflow", { cause: new ProviderContextOverflowError() });
  f.invoke.mockRejectedValueOnce(disconnected()).mockRejectedValueOnce(overflow).mockRejectedValueOnce(disconnected());
  const accept = vi.fn((text: string) => text);
  const result = f.invoker.invoke({
    modelStep: "execution.decision", messages: original, timeoutReason: "stream_recovery_timeout",
    contextCompaction: createAdmissionController([stage]), accept,
  }).catch(error => error);
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toMatchObject({ name: "ModelProviderFailure", stage: "model_provider_stream" });
  expect(f.invoke).toHaveBeenCalledTimes(3);
  expect(f.invoke.mock.calls.map(([input]) => input.messages)).toEqual([original, original, compacted]);
  expect(stage.commit).toHaveBeenCalledOnce();
  expect(accept).not.toHaveBeenCalled();
});

test("failed thinking remains an error trace and cannot become the successful attempt trace", async () => {
  const f = streamFixture();
  f.invoke.mockImplementationOnce(async input => {
    input.onThinking?.("Interrupted reasoning.");
    throw disconnected();
  }).mockImplementationOnce(async input => {
    input.onThinking?.("Replacement reasoning.");
    return { text: "Complete answer.", meta: {} };
  });
  const result = f.start();
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toBe("Complete answer.");
  expect(f.request.onThinkingTrace).toHaveBeenNthCalledWith(1, {
    step: "execution.decision", status: "error", text: "Interrupted reasoning.",
  });
  expect(f.request.onThinkingTrace).toHaveBeenNthCalledWith(2, {
    step: "execution.decision", status: "completed", text: "Replacement reasoning.",
  });
  expect(f.request.onThinkingDelta).toHaveBeenNthCalledWith(1, "Interrupted reasoning.");
  expect(f.request.onThinkingDelta).toHaveBeenNthCalledWith(2, "Replacement reasoning.");
  expect(f.invoke.mock.calls[1]![0].messages).toEqual(ADMISSION_MESSAGES);
});
