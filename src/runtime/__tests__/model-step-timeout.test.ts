import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { invokeModelStep } from "../model/invoke-step.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function invokeWorkerResult(
  invoke: ModelGatewayClient["invoke"],
  abortSignal: AbortSignal,
) {
  const initial = createInvalidOutputRequest(invoke);
  const request = deriveTestRequestExecutionScope(initial, {
    abortSignal,
    runnerConfig: {
      ...initial.runnerConfig,
      steps: {
        ...initial.runnerConfig.steps,
        "worker.result": { timeoutMs: 5 },
      },
    },
  });
  const accept = vi.fn((text: string) => text);
  const result = invokeModelStep({
    request,
    modelStep: "worker.result",
    messages: [{ role: "user", content: "Return the bounded result." }],
    timeoutReason: "worker_result_timeout",
    accept,
  });
  return { result, accept };
}

describe("model step timeout provenance and cancellation", () => {
  test.each(["reject", "late_response"] as const)(
    "retains the local timeout when the provider settles with %s",
    async (settlement) => {
      const parent = new AbortController();
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(
        (input) =>
          new Promise((resolve, reject) => {
            input.abortSignal.addEventListener(
              "abort",
              () => {
                if (settlement === "reject") {
                  reject(new DOMException("Provider aborted", "AbortError"));
                  return;
                }
                resolve({
                  text: "Late result must not be accepted.",
                  meta: {},
                });
              },
              { once: true },
            );
          }),
      );
      const { result, accept } = invokeWorkerResult(invoke, parent.signal);
      await expect(result).rejects.toMatchObject({
        name: "ModelStepTimeoutError",
        code: "worker_result_timeout",
        modelStep: "worker.result",
        stage: "model_step_timeout",
      });
      expect(parent.signal.aborted).toBe(false);
      expect(accept).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledOnce();
    },
  );

  test.each(["request_cancelled", "request_timeout"])(
    "preserves %s even when the local timeout fires first",
    async (reason) => {
      const parent = new AbortController();
      const failure = new Error(reason);
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(
        (input) =>
          new Promise((_, reject) => {
            input.abortSignal.addEventListener(
              "abort",
              () => {
                parent.abort(failure);
                reject(input.abortSignal.reason);
              },
              { once: true },
            );
          }),
      );
      const { result, accept } = invokeWorkerResult(invoke, parent.signal);
      await expect(result).rejects.toBe(failure);
      expect(accept).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledOnce();
    },
  );

  test("does not reclassify an arbitrary timeout-looking provider error", async () => {
    const failure = new Error("worker_result_timeout");
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
      throw failure;
    });
    const { result, accept } = invokeWorkerResult(
      invoke,
      new AbortController().signal,
    );
    await expect(result).rejects.toBe(failure);
    expect(accept).not.toHaveBeenCalled();
  });
});
