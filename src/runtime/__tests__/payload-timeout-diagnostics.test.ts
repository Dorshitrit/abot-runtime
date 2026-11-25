import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import { routeFilePayloadAuthor } from "../request/execution-file-payload/author.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { normalizePayloadAuthoringResult } from "../adapters/registered-tool-worker-capabilities/payload-authoring-result.js";
import { payloadAuthoringFailureMessage } from "../adapters/registered-tool-worker-capabilities/payload-authoring-failure.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { filePayloadFixture, filePayloadInput } from "./support/execution-file-payload-fixture.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createTestRequestWorkerCapabilityPayloadAuthor } from "./support/worker-payload-author.js";

const MODES = ["worker", "ea"] as const;
type Mode = typeof MODES[number];
const DEADLINE = 20_000;

beforeEach(() => {
  configureDebugLogger({ enabled: false });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  resetDebugLoggerConfig();
});

async function fixture(mode: Mode, invoke: ModelGatewayClient["invoke"], controller = new AbortController()) {
  if (mode === "ea") {
    const f = await filePayloadFixture({
      abortSignal: controller.signal,
      modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    });
    const author = routeFilePayloadAuthor(f.request, { author: vi.fn() },
      resolveRequestExecutionPolicy("execution-agent-v1").authority);
    return { controller, request: f.request, author: () => author.author(filePayloadInput()) };
  }
  const initial = createInvalidOutputRequest(invoke);
  const request = deriveTestRequestExecutionScope(initial, {
    abortSignal: controller.signal,
    runnerConfig: { ...initial.runnerConfig,
      steps: { ...initial.runnerConfig.steps, "tool_payload.raw": { timeoutMs: DEADLINE } } },
  });
  const { preparedPayload: _prepared, requestSteering: _steering, ...input } = filePayloadInput();
  const author = createTestRequestWorkerCapabilityPayloadAuthor(request);
  return { controller, request, author: () => author.author({ ...input,
    call: { ...input.call, callId: "call-2", parentCallId: "call-1", roleId: "worker",
      depth: 1, activationCount: 1, objective: "Apply the accepted precise file change." } }) };
}

async function pendingAuthor(mode: Mode) {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>((input) => new Promise((_, reject) => {
    input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason), { once: true });
    markStarted();
  }));
  const f = await fixture(mode, invoke);
  const outcome = f.author().then(
    (result) => ({ status: "resolved" as const, result }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await Promise.race([started, outcome.then((value) => {
    throw new Error(`author_finished_before_provider:${JSON.stringify(value)}`);
  })]);
  return { ...f, invoke, outcome, signal: invoke.mock.calls[0]![0].abortSignal };
}

test.each(MODES)("%s owned deadline retains the effective duration without cancelling the request or retrying", async (mode) => {
  const f = await pendingAuthor(mode);
  await vi.advanceTimersByTimeAsync(DEADLINE - 1);
  expect(f.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(f.outcome).resolves.toEqual({ status: "resolved", result: {
    status: "failed", code: "payload_model_timed_out", timeoutMs: DEADLINE,
  } });
  expect(f.signal.reason).toBeInstanceOf(ModelStepTimeoutError);
  expect(f.signal.reason).toMatchObject({ timeoutMs: DEADLINE,
    modelStep: mode === "worker" ? "tool_payload.raw" : "execution.file_payload.raw" });
  expect(f.request.abortSignal.aborted).toBe(false);
  expect(f.invoke).toHaveBeenCalledOnce();
});

test.each(MODES)("%s request cancellation keeps priority over its pending model deadline", async (mode) => {
  const f = await pendingAuthor(mode);
  f.controller.abort(new DOMException("User cancelled", "AbortError"));
  await vi.advanceTimersByTimeAsync(DEADLINE);
  await expect(f.outcome).resolves.toMatchObject({ status: "rejected", error: { name: "AbortError" } });
  expect(f.signal.reason).not.toBeInstanceOf(ModelStepTimeoutError);
  expect(f.invoke).toHaveBeenCalledOnce();
});

test.each(MODES)("%s accepts a matching typed deadline with unknown duration", async (mode) => {
  const step = mode === "worker" ? "tool_payload.raw" : "execution.file_payload.raw";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    throw new ModelStepTimeoutError("owned_deadline", step);
  });
  const f = await fixture(mode, invoke);
  await expect(f.author()).resolves.toEqual({ status: "failed", code: "payload_model_timed_out" });
  expect(invoke).toHaveBeenCalledOnce();
});

test.each(MODES)("%s does not infer a payload timeout from another step or an ordinary error", async (mode) => {
  for (const error of [
    new ModelStepTimeoutError("other_deadline", "worker.result", DEADLINE),
    Object.assign(new Error("SECRET_PROVIDER_DETAIL: timeout after 20000"), {
      name: "ModelStepTimeoutError", modelStep: mode === "worker" ? "tool_payload.raw" : "execution.file_payload.raw",
      timeoutMs: DEADLINE,
    }),
  ]) {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => { throw error; });
    const f = await fixture(mode, invoke);
    await expect(f.author()).resolves.toEqual({ status: "failed", code: "payload_model_invocation_failed" });
    expect(invoke).toHaveBeenCalledOnce();
  }
});

test("timeout metadata is strict and its public message never copies provider detail", () => {
  const failure = { status: "failed", code: "payload_model_timed_out", timeoutMs: DEADLINE } as const;
  expect(normalizePayloadAuthoringResult(failure, 0, 100)).toEqual(failure);
  const unknown = normalizePayloadAuthoringResult({ status: "failed", code: failure.code }, 0, 100);
  expect(unknown).toEqual({ status: "failed", code: failure.code });
  if (unknown.status !== "failed") throw new Error("expected_timeout_failure");
  expect(payloadAuthoringFailureMessage(failure, "fallback"))
    .toBe("Payload generation timed out after 20000 ms. No tool action was executed.");
  expect(payloadAuthoringFailureMessage(unknown, "fallback"))
    .toBe("Payload generation timed out. No tool action was executed.");
  for (const malformed of [
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "20000", null, undefined]
      .map((timeoutMs) => ({ ...failure, timeoutMs })),
    { ...failure, message: "SECRET_PROVIDER_DETAIL" },
    { ...failure, code: "payload_model_invocation_failed" },
  ]) {
    expect(normalizePayloadAuthoringResult(malformed, 0, 100))
      .toEqual({ status: "failed", code: "payload_author_result_invalid" });
  }
});
