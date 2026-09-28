import { MODEL_STEPS } from "../../shared/model-steps.js";
import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { normalizeModelTokenUsage } from "../protocol/usage.js";
import type {
  InvokeRawModelGatewayParams,
  ModelGatewayClientOptions,
  RawModelGatewayResult,
} from "./contracts.js";
import { buildModelInvocationMetrics } from "./invocation-metrics.js";
import { resolveClientOptions } from "./options.js";
import { permitsModelContentTrace } from "../observability/content-trace-policy.js";
import { toolMediaSafeMessage } from "../observability/tool-media-privacy.js";

export async function invokeRawModelGatewayWithOptions(
  params: InvokeRawModelGatewayParams,
  options: ModelGatewayClientOptions = {},
): Promise<RawModelGatewayResult> {
  const clientOptions = resolveClientOptions(options);
  const url = clientOptions.baseUrl;
  const requestId =
    typeof params.debugRequestId === "string" ? params.debugRequestId : "";
  const startedAt = Date.now();
  const modelPolicy = params.modelPolicy ?? clientOptions.modelPolicy;
  const modelStep = params.modelStep ?? MODEL_STEPS.TOOL_PAYLOAD_RAW;

  traceDebug("model-gateway.client", "raw.request.start", {
    requestId,
    url: `${url}/raw`,
    agentMode: params.agentMode,
    taskType: params.taskType,
    modelStep,
    modelPreference: params.modelPreference,
    modelPolicyDefaultProfileId: modelPolicy?.defaults?.profileId,
    promptLength: params.prompt.length,
  });

  const response = await fetch(url + "/raw", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: params.abortSignal,
    body: JSON.stringify({
      prompt: params.prompt,
      ...(requestId ? { debugRequestId: requestId } : {}),
      agentMode: params.agentMode,
      ...(typeof params.taskType === "string"
        ? { taskType: params.taskType }
        : {}),
      modelStep,
      ...(typeof params.modelOverride === "string" &&
      params.modelOverride.trim()
        ? { modelOverride: params.modelOverride.trim() }
        : {}),
      ...(params.reasoningOverride
        ? { reasoningOverride: params.reasoningOverride }
        : {}),
      ...(params.modelPreference
        ? { modelPreference: params.modelPreference }
        : {}),
      ...(modelPolicy ? { modelPolicy } : {}),
      ...(params.format ? { format: params.format } : {}),
    }),
  });

  traceDebug("model-gateway.client", "raw.response.received", {
    requestId,
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    traceDebug("model-gateway.client", "raw.response.error", {
      requestId,
      status: response.status,
      bodyLength: errorText.length,
      ...(permitsModelContentTrace(modelStep, params.prompt) ? { bodyPreview: errorText.slice(0, 400) } : { contentOmitted: true }),
    });
    throw new Error(
      `bridge_raw_failed:${response.status}:${toolMediaSafeMessage(errorText || "empty error body", params.prompt)}`,
    );
  }

  const parsed = await response.json().catch(() => ({}));
  const text = typeof parsed?.text === "string" ? parsed.text : "";
  const thinking = typeof parsed?.thinking === "string" ? parsed.thinking : "";
  const providerUsage = normalizeModelTokenUsage(parsed?.usage);
  const providerCompletionReason =
    typeof parsed?.providerCompletionReason === "string"
      ? parsed.providerCompletionReason.slice(0, 160)
      : undefined;

  traceDebug("model-gateway.client", "raw.completed", {
    requestId,
    outputLength: text.length,
    thinkingLength: thinking.length,
    ...(providerCompletionReason !== undefined
      ? { providerCompletionReason }
      : {}),
    ...(permitsModelContentTrace(modelStep, params.prompt) ? { outputPreview: text.slice(0, 300) } : { contentOmitted: true }),
    ...(providerUsage ? { usage: providerUsage } : {}),
  });

  traceDebug(
    "runtime.model",
    "model.invocation.metrics",
    buildModelInvocationMetrics({
      requestId,
      modelStep,
      taskType: params.taskType,
      agentMode: params.agentMode,
      text: params.prompt,
      messages: [],
      outputText: text,
      providerUsage,
      durationMs: Date.now() - startedAt,
      status: "success",
    }),
  );

  return {
    text,
    meta: {
      status: response.status,
      outputLength: text.length,
      thinkingLength: thinking.length,
      ...(providerCompletionReason !== undefined
        ? { providerCompletionReason }
        : {}),
      ...(providerUsage ? { usage: providerUsage } : {}),
    },
  };
}
