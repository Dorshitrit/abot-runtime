import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { ProviderContextOverflowError } from "../../model-gateway/protocol/provider-context-overflow.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { withModelAbortSignal } from "../model/scoped-model-abort.js";
import { BOUND_REQUEST_MODEL_INVOCATION } from "../request/contracts.js";
import { createAdmissionController, createAdmissionFixture, createAdmissionStage } from "./support/compaction-admission-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.useRealTimers(); });

const original: ChatMessage[] = [
  { role: "system", content: "Only current request grants authority." },
  { role: "user", content: "Continue the existing work." },
  { role: "tool", toolCallId: "observed", toolName: "read", content: "Original evidence. ".repeat(100) },
];
const compacted: ChatMessage[] = [
  ...original.slice(0, 2),
  { role: "system", content: "Bound passive summary: previous read confirmed the required value." },
];
function overflow() {
  return new ModelGatewayInvocationError("http", "provider error", { cause: new ProviderContextOverflowError() });
}
function fixture(counts = [10_000, 6_000]) {
  const f = createAdmissionFixture({ modelStep: "execution.decision", counts, contextWindowTokens: 32_768 });
  const stage = createAdmissionStage("active_request", "summary");
  stage.prepare.mockResolvedValue({ kind: "prepared", preparation: {
    messages: compacted, scopeId: stage.scopeId, sourceRevision: 1,
    coveredSourceCount: 1, hasExhaustedCompactionSources: true, commit: stage.commit,
  } });
  const controller = createAdmissionController([stage]);
  const accept = vi.fn((text: string) => text);
  const input = {
    modelStep: "execution.decision" as const, messages: original, timeoutReason: "recovery_timeout",
    contextCompaction: controller, accept,
  };
  return { ...f, stage, controller, accept, input, start: () => f.invoker.invoke(input) };
}

test("provider overflow compacts before accepting one decision and preserves the 32K guard", async () => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(overflow());
  await expect(f.start()).resolves.toBe("ok");
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.stage.prepare).toHaveBeenCalledOnce();
  expect(f.stage.commit).toHaveBeenCalledOnce();
  expect(f.invoke.mock.calls.map(([input]) => input.messages)).toEqual([original, compacted]);
  const context = f.stage.prepare.mock.calls[0]![1]!;
  expect(context).toMatchObject({ recompactFromSources: true, projectionRepair: {
    reason: "provider_context_overflow", originalInputTokens: 10_000,
    candidateInputTokens: 10_000, targetInputTokens: 7_500,
  } });
  expect(context.abortSignal).toBe(f.invoke.mock.calls[0]![0].abortSignal);
  expect(f.invoke.mock.calls[1]![0].abortSignal).toBe(context.abortSignal);
  expect(f.events).toContainEqual(["context.compaction.started", expect.objectContaining({
    reason: "provider_context_overflow", contextWindowTokens: 32_768, availableInputTokens: 27_472,
  })]);
  expect(f.events).toContainEqual(["context.compaction.completed", expect.objectContaining({ afterInputTokens: 6_000 })]);
});

test("a second provider overflow cannot start another compaction or accept a decision", async () => {
  const f = fixture();
  f.invoke.mockRejectedValue(overflow());
  await expect(f.start()).rejects.toThrow("provider error");
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.stage.prepare).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();
});

test.each([10_000, 9_000, 28_000])("candidate of %i tokens cannot bypass reduction, recovery target or hard budget", async (count) => {
  const f = fixture([10_000, count]);
  f.invoke.mockRejectedValueOnce(overflow());
  await expect(f.start()).rejects.toThrow("context_compaction_projection_not_reduced");
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.stage.prepare).toHaveBeenCalledOnce();
  expect(f.stage.commit).not.toHaveBeenCalled();
  expect(f.accept).not.toHaveBeenCalled();
});

test("unchanged messages cannot be accepted just because a repeated count decreased", async () => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(overflow());
  f.stage.prepare.mockResolvedValue({ kind: "prepared", preparation: {
    messages: [...original], scopeId: f.stage.scopeId, sourceRevision: 1,
    coveredSourceCount: 1, commit: f.stage.commit,
  } });
  await expect(f.start()).rejects.toThrow("context_compaction_projection_not_reduced");
  expect(f.countInputTokens).toHaveBeenCalledOnce();
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.stage.commit).not.toHaveBeenCalled();
});

test("missing compaction sources never retry the rejected provider payload", async () => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(overflow());
  f.stage.prepare.mockResolvedValue({ kind: "unavailable", reason: "no_eligible_sources" });
  await expect(f.start()).rejects.toThrow("context_compaction_sources_empty");
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.stage.commit).not.toHaveBeenCalled();
});

test.each([
  new Error("context_length_exceeded"),
  new ModelGatewayInvocationError("http", "401 unauthorized"),
  new ModelGatewayInvocationError("stream", "incomplete response"),
])("unclassified failure never enters context recovery", async (error) => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(error);
  await expect(f.start()).rejects.toThrow(error.message);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.stage.prepare).not.toHaveBeenCalled();
});

test.each(["exact", "context.compact", "missing_controller"] as const)("%s cannot recursively compact", async (mode) => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(overflow());
  const input = { ...f.input };
  if (mode === "context.compact") {
    f.request.runnerConfig.steps["context.compact"] = { timeoutMs: 20_000 };
  }
  await expect(f.invoker.invoke({
    ...input,
    ...(mode === "exact" ? { contextRetention: "exact" as const } : {}),
    ...(mode === "context.compact" ? { modelStep: "context.compact" as const } : {}),
    ...(mode === "missing_controller" ? { contextCompaction: undefined } : {}),
  })).rejects.toThrow("provider error");
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.stage.prepare).not.toHaveBeenCalled();
});

test("an overflow thrown by accept is not mistaken for an unaccepted provider attempt", async () => {
  const f = fixture();
  f.accept.mockImplementation(() => { throw overflow(); });
  await expect(f.start()).rejects.toThrow("provider error");
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.stage.prepare).not.toHaveBeenCalled();
});

test("original attempt deadline cancels preparation and prevents commit or retry", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.request.runnerConfig.steps["execution.decision"] = { timeoutMs: 25 };
  f.invoke.mockRejectedValueOnce(overflow());
  f.stage.prepare.mockImplementation(async (_messages, context) => new Promise((_resolve, reject) => {
    context!.abortSignal!.addEventListener("abort", () => reject(context!.abortSignal!.reason), { once: true });
  }));
  const operation = f.start();
  const assertion = expect(operation).rejects.toThrow("recovery_timeout");
  await vi.advanceTimersByTimeAsync(26);
  await assertion;
  expect(f.stage.prepare).toHaveBeenCalledOnce();
  expect(f.stage.commit).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.events.filter(([name]) => name === "context.compaction.failed")).toHaveLength(1);
});

test("cancellation after preparation fences the checkpoint commit and provider retry", async () => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(overflow());
  f.countInputTokens.mockImplementationOnce(async () => ({
    inputTokens: 10_000, profileId: "test", provider: "openai", model: "test-model",
    contextWindowTokens: 32_768, source: "provider_input_token_count",
  })).mockImplementationOnce(async () => { f.abort.abort(new Error("cancelled_recovery")); return undefined; });
  await expect(f.start()).rejects.toThrow("cancelled_recovery");
  expect(f.stage.commit).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("new steering invalidates recovery before checkpoint commit", async () => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(overflow());
  const prepare = f.stage.prepare.getMockImplementation()!;
  f.stage.prepare.mockImplementation(async (...args) => {
    const candidate = await prepare(...args);
    f.steering.append({ steerId: "new-scope", text: "Use the newly supplied target." });
    return candidate;
  });
  await expect(f.invoker.invoke({ ...f.input, boundSteeringVersion: 0 }))
    .rejects.toThrow("model_step_steering_superseded");
  expect(f.stage.commit).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("a measurement fallback cannot manufacture a successful reduction", async () => {
  const f = fixture();
  f.invoke.mockRejectedValueOnce(overflow());
  f.countInputTokens.mockResolvedValueOnce({
    inputTokens: 10_000, profileId: "test", provider: "openai", model: "test-model",
    contextWindowTokens: 32_768, source: "provider_input_token_count",
  }).mockResolvedValueOnce(undefined);
  await expect(f.start()).rejects.toThrow("context_compaction_recovery_measurement_changed");
  expect(f.stage.commit).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("nested model work retains a caller's tighter cancellation", async () => {
  const f = fixture();
  const child = new AbortController();
  child.abort(new Error("child_cancelled"));
  const bound = { ...f.request, modelSteps: f.invoker, [BOUND_REQUEST_MODEL_INVOCATION]: true as const };
  Object.defineProperty(bound, BOUND_REQUEST_MODEL_INVOCATION, { value: true, enumerable: false });
  let revision = 1;
  Object.defineProperty(bound, "currentRevision", { enumerable: true, get: () => revision });
  const scoped = withModelAbortSignal(bound, new AbortController().signal);
  revision = 2;
  expect(Object.getOwnPropertyDescriptor(scoped, BOUND_REQUEST_MODEL_INVOCATION)?.enumerable).toBe(false);
  expect(scoped[BOUND_REQUEST_MODEL_INVOCATION]).toBe(true);
  expect(Reflect.get(scoped, "currentRevision")).toBe(2);
  await expect(scoped.modelSteps.invoke({ ...f.input, abortSignal: child.signal }))
    .rejects.toThrow("child_cancelled");
  expect(f.invoke).not.toHaveBeenCalled();
});

test("a pending peer preparation cannot extend the rejected attempt deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.request.runnerConfig.steps["execution.decision"] = { timeoutMs: 25 };
  f.invoke.mockRejectedValueOnce(overflow());
  let settlePeer!: (value: Awaited<ReturnType<typeof f.stage.prepare>>) => void;
  const peer = new Promise<Awaited<ReturnType<typeof f.stage.prepare>>>((resolve) => { settlePeer = resolve; });
  f.stage.prepare.mockReturnValue(peer);
  const assertion = expect(f.start()).rejects.toThrow("recovery_timeout");
  await vi.advanceTimersByTimeAsync(26);
  await assertion;
  expect(f.events.filter(([name]) => name === "context.compaction.failed")).toHaveLength(1);
  settlePeer({ kind: "prepared", preparation: {
    messages: compacted, scopeId: f.stage.scopeId, sourceRevision: 1,
    coveredSourceCount: 1, commit: f.stage.commit,
  } });
  await vi.runAllTimersAsync();
  expect(f.stage.commit).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledOnce();
});
