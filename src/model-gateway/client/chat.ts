import { traceDebug } from "../../runtime/observability/debug-logger.js";
import type {
  InvokeModelGatewayParams,
  ModelGatewayClientOptions,
  StreamMeta,
} from "./contracts.js";
import { buildModelInvocationMetrics } from "./invocation-metrics.js";
import {
  buildChatGatewayRequestBody,
  resolveMetricMessages,
  resolveRequestMessages,
} from "./message-projection.js";
import { resolveClientOptions } from "./options.js";
import {
  ChatStreamAccumulator,
  classifyEmptyResponse,
  InactivityBoundStreamReader,
} from "./stream-consumer.js";

export async function invokeModelGatewayWithOptions(
  params: InvokeModelGatewayParams,
  options: ModelGatewayClientOptions = {},
): Promise<{ text: string; meta: StreamMeta }> {
  const clientOptions = resolveClientOptions(options);
  const url = clientOptions.baseUrl;
  const requestId =
    typeof params.debugRequestId === "string" ? params.debugRequestId : "";
  const requestMessages = resolveRequestMessages(params);
  const metricMessages = resolveMetricMessages(params);
  const startedAt = Date.now();
  const modelPolicy = params.modelPolicy ?? clientOptions.modelPolicy;
  const requestBody = buildChatGatewayRequestBody(
    params,
    requestMessages,
    modelPolicy,
  );

  traceDebug("model-gateway.client", "chat.request.start", {
    requestId,
    url: `${url}/chat`,
    agentMode: params.agentMode,
    taskType: params.taskType,
    modelStep: params.modelStep,
    modelPreference: params.modelPreference,
    modelPolicyDefaultProfileId: modelPolicy?.defaults?.profileId,
    textLength: typeof params.text === "string" ? params.text.length : 0,
    messageCount: requestMessages.length,
  });

  const response = await fetch(url + "/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: params.abortSignal,
    body: JSON.stringify(requestBody),
  });

  traceDebug("model-gateway.client", "chat.response.received", {
    requestId,
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    traceDebug("model-gateway.client", "chat.response.error", {
      requestId,
      status: response.status,
      bodyLength: errorText.length,
      bodyPreview: errorText.slice(0, 400),
    });
    throw new Error(
      `bridge_request_failed:${response.status}:${errorText || "empty error body"}`,
    );
  }

  if (!response.body) {
    traceDebug("model-gateway.client", "chat.response.no_body", {
      requestId,
    });
    throw new Error("no stream");
  }

  const streamReader = new InactivityBoundStreamReader(
    response.body.getReader(),
    params.abortSignal,
    clientOptions.getStreamInactivityTimeoutMs,
  );
  const stream = new ChatStreamAccumulator(params);

  while (true) {
    const { done, value } = await streamReader.read();
    if (done) break;
    stream.acceptChunk(value);
  }

  stream.flushPending();
  const meta = stream.toMeta(response.status);

  traceDebug("model-gateway.client", "chat.stream.completed", {
    requestId,
    chunkCount: meta.chunkCount,
    totalBytes: meta.totalBytes,
    thinkingEvents: meta.thinkingEvents,
    contentEvents: meta.contentEvents,
    contentEmptyEvents: meta.contentEmptyEvents,
    invalidJsonLines: meta.invalidJsonLines,
    unknownTypeCounts: meta.unknownTypeCounts,
    outputLength: stream.text.length,
    terminalEventCount: meta.terminalEventCount,
    ...(stream.providerCompletionReason !== undefined
      ? { providerCompletionReason: stream.providerCompletionReason }
      : {}),
    ...(stream.providerUsage ? { usage: stream.providerUsage } : {}),
  });

  if (stream.text.trim().length === 0) {
    const emptyReason = classifyEmptyResponse(meta);
    traceDebug("model-gateway.client", "chat.stream.empty_output", {
      requestId,
      emptyReason,
      responseShape: {
        status: meta.status,
        chunkCount: meta.chunkCount,
        totalBytes: meta.totalBytes,
        thinkingEvents: meta.thinkingEvents,
        contentEvents: meta.contentEvents,
        contentEmptyEvents: meta.contentEmptyEvents,
        invalidJsonLines: meta.invalidJsonLines,
        unknownTypeCounts: meta.unknownTypeCounts,
      },
    });
    meta.emptyReason = emptyReason;
  }

  traceDebug(
    "runtime.model",
    "model.invocation.metrics",
    buildModelInvocationMetrics({
      requestId,
      modelStep: params.modelStep,
      taskType: params.taskType,
      agentMode: params.agentMode,
      text: params.text,
      messages: metricMessages,
      outputText: stream.text,
      providerUsage: stream.providerUsage,
      terminalEventCount: meta.terminalEventCount,
      ...(stream.providerCompletionReason !== undefined
        ? { providerCompletionReason: stream.providerCompletionReason }
        : {}),
      durationMs: Date.now() - startedAt,
      status: "success",
    }),
  );

  return { text: stream.text, meta };
}
