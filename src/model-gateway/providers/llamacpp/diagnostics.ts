import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import type { ModelProviderInvocationParams } from "../contracts.js";

export function emitLlamaCppStreamTermination(
  params: ModelProviderInvocationParams, startedAt: number, error?: unknown,
): void {
  const aborted = !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
  traceDebug("model-gateway.server", "llamacpp.stream.terminated", {
    requestId: params.requestBody.debugRequestId ?? "",
    endpoint: params.endpoint, modelStep: params.requestBody.modelStep ?? "",
    profileId: params.invocation.profile.id, providerId: params.invocation.profile.providerId,
    provider: "llamacpp", model: params.invocation.model, elapsedMs: Date.now() - startedAt,
    outcome: error === undefined ? "completed" : aborted ? "aborted" : "failed",
    abortRequested: aborted,
    ...(params.invocation.think !== undefined ? { reasoningEffort: params.invocation.think } : {}),
    ...(params.invocation.reasoningBudget ? { reasoningBudget: params.invocation.reasoningBudget } : {}),
    ...(params.invocation.reasoningControlSource ? { reasoningControlSource: params.invocation.reasoningControlSource } : {}),
    ...(error !== undefined ? { error: error instanceof Error
      ? { name: error.name, message: error.message } : { name: "Error", message: String(error) } } : {}),
  });
}
