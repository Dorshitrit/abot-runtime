import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { invokeModelStep } from "../model/invoke-step.js";
import {
  ModelProviderFailure,
  projectModelProviderFailureDiagnostics,
} from "../model/provider-failure.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
  traceDebug,
} from "../observability/debug-logger.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

vi.mock("../observability/debug-logger.js", () => ({
  configureDebugLogger: vi.fn(),
  resetDebugLoggerConfig: vi.fn(),
  traceDebug: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  configureDebugLogger({ enabled: false });
});
afterEach(() => resetDebugLoggerConfig());

function invokeWorkerResult(
  invoke: ModelGatewayClient["invoke"],
  abortSignal = new AbortController().signal,
) {
  const request = deriveTestRequestExecutionScope(
    createInvalidOutputRequest(invoke),
    {
      abortSignal,
    },
  );
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

describe("model provider failure ownership", () => {
  test.each([
    "network",
    "http",
    "stream",
    "inactivity",
    "missing_stream",
  ] as const)(
    "binds %s failure once without accepting or retrying output",
    async (kind) => {
      const failure = new ModelGatewayInvocationError(
        kind,
        "provider diagnostic",
      );
      const invoke = vi
        .fn<ModelGatewayClient["invoke"]>()
        .mockRejectedValue(failure);
      const { result, accept } = invokeWorkerResult(invoke);
      await expect(result).rejects.toMatchObject({
        name: "ModelProviderFailure",
        message: failure.message,
        cause: failure,
        modelStep: "worker.result",
        code: "model_provider_failure",
        stage: `model_provider_${kind}`,
      });
      expect(invoke).toHaveBeenCalledOnce();
      expect(accept).not.toHaveBeenCalled();
      expect(traceDebug).toHaveBeenCalledWith(
        "runtime.model",
        "step.failed",
        expect.objectContaining({
          providerFailureCode: "model_provider_failure",
          providerFailureStage: `model_provider_${kind}`,
          providerErrorPreview: failure.message,
        }),
      );
    },
  );

  test.each([
    new Error(
      "model_stream_error: ollama_stream_error: prediction aborted, token repeat limit reached",
    ),
    new TypeError("local_callback_failed"),
    Object.assign(new Error("spoofed provider failure"), {
      name: "ModelGatewayInvocationError",
      kind: "stream",
    }),
  ])("preserves untyped or internal failure identity: %s", async (failure) => {
    const invoke = vi
      .fn<ModelGatewayClient["invoke"]>()
      .mockRejectedValue(failure);
    const { result, accept } = invokeWorkerResult(invoke);
    await expect(result).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
  });

  test.each(["request_cancelled", "request_timeout"])(
    "%s takes priority over a concurrent provider failure",
    async (reason) => {
      const abort = new AbortController();
      const cancellation = new Error(reason);
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
        abort.abort(cancellation);
        throw new ModelGatewayInvocationError("stream", "provider failed too");
      });
      const { result, accept } = invokeWorkerResult(invoke, abort.signal);
      await expect(result).rejects.toBe(cancellation);
      expect(invoke).toHaveBeenCalledOnce();
      expect(accept).not.toHaveBeenCalled();
    },
  );

  test("provider diagnostics are bounded and obey existing media and passive privacy", () => {
    const diagnostic = "private provider detail ".repeat(100);
    const cause = new ModelGatewayInvocationError("stream", diagnostic);
    const workerError = new ModelProviderFailure("worker.decision", cause);
    expect(
      projectModelProviderFailureDiagnostics(workerError, []),
    ).toMatchObject({
      providerErrorPreview: diagnostic.slice(0, 400),
    });
    for (const [error, messages] of [
      [
        workerError,
        [{ role: "user", content: JSON.stringify({ kind: "tool_image_v1" }) }],
      ],
      [new ModelProviderFailure("learning.batch", cause), []],
    ] as const) {
      const projected = projectModelProviderFailureDiagnostics(error, messages);
      expect(projected).toMatchObject({ contentOmitted: true });
      expect(projected).not.toHaveProperty("providerErrorPreview");
      expect(JSON.stringify(projected)).not.toContain(
        "private provider detail",
      );
    }
    expect(
      projectModelProviderFailureDiagnostics(new Error(diagnostic), []),
    ).toEqual({});
  });
});
