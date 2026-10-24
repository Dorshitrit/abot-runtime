import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildModelConfig as buildSetupModelConfig } from "../../../scripts/runtime-setup-files.js";
import { buildRuntimeModelConfiguration } from "../config/builders.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import { RequestModelStepInvoker } from "../model/invoke-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => {
  configureDebugLogger({ enabled: false });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  resetDebugLoggerConfig();
});

async function startPendingInvocation(
  provider: "openai" | "ollama",
  modelStep: "tool_payload.raw" | "worker.result",
) {
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>((input) => new Promise((_, reject) => {
    input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason), { once: true });
    providerStarted();
  }));
  const initial = createInvalidOutputRequest(invoke);
  const runnerConfig = {
    ...initial.runnerConfig,
    models: {
      defaults: { profileId: "test", steps: { "tool_payload.raw": "toolPayload.raw" } },
    },
    steps: {
      ...initial.runnerConfig.steps,
      "tool_payload.raw": { timeoutMs: 90_000 },
      "worker.result": { timeoutMs: 90_000 },
    },
  };
  const generatedProfile = buildSetupModelConfig({}, provider, "deadline-fixture", 64_000);
  const platformPolicy = buildRuntimeModelConfiguration({
    models: {
      providers: { [provider]: { type: provider } },
      profiles: { test: generatedProfile },
    },
  }).modelPolicy;
  const request = deriveTestRequestExecutionScope(initial, {
    runnerConfig,
    modelPolicy: createRequestModelPolicy({ platformPolicy, runnerConfig }),
  });
  const accept = vi.fn((text: string) => text);
  const result = new RequestModelStepInvoker(request).invoke({
    modelStep,
    messages: [{ role: "user", content: "Return the requested payload." }],
    timeoutReason: "payload_deadline_fixture_timeout",
    accept,
  });
  const outcome = result.then(
    () => ({ status: "succeeded" as const }),
    (error: unknown) => ({ status: "failed" as const, error }),
  );
  await started;
  return { request, invoke, accept, outcome, signal: invoke.mock.calls[0]![0].abortSignal };
}

test("setup-generated OpenAI payload keeps its actual invocation alive beyond 90 seconds and times out at 300 seconds", async () => {
  const invocation = await startPendingInvocation("openai", "tool_payload.raw");

  await vi.advanceTimersByTimeAsync(90_000);
  expect(invocation.signal.aborted).toBe(false);
  expect(invocation.accept).not.toHaveBeenCalled();
  expect(invocation.invoke).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(209_999);
  expect(invocation.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(invocation.outcome).resolves.toMatchObject({
    status: "failed",
    error: {
      name: "ModelStepTimeoutError",
      code: "payload_deadline_fixture_timeout",
      modelStep: "tool_payload.raw",
      stage: "model_step_timeout",
    },
  });
  expect(invocation.signal.aborted).toBe(true);
  expect(invocation.request.abortSignal.aborted).toBe(false);
  expect(invocation.accept).not.toHaveBeenCalled();
  expect(invocation.invoke).toHaveBeenCalledOnce();
});

test.each([
  ["ollama", "tool_payload.raw"],
  ["openai", "worker.result"],
] as const)("preserves the runner deadline for %s / %s", async (provider, modelStep) => {
  const invocation = await startPendingInvocation(provider, modelStep);

  await vi.advanceTimersByTimeAsync(89_999);
  expect(invocation.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(invocation.outcome).resolves.toMatchObject({
    status: "failed",
    error: { name: "ModelStepTimeoutError", modelStep },
  });
  expect(invocation.request.abortSignal.aborted).toBe(false);
  expect(invocation.accept).not.toHaveBeenCalled();
  expect(invocation.invoke).toHaveBeenCalledOnce();
});
