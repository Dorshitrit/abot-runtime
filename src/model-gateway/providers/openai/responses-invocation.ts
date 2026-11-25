import { readOpenAIHttpContextOverflow } from "./context-overflow.js";
import { fetchProviderWithTrace } from "../../model-io-trace.js";
import { toolMediaSafeError, toolMediaSafeEvent, toolMediaSafeMessage } from "../../observability/tool-media-privacy.js";
import type { ModelProviderInvocationParams, ModelProviderInvocationResult } from "../contracts.js";
import {
  emitOpenAIMessageOutputDiagnostic,
  emitOpenAIStreamTermination,
  resolveOpenAIStreamFailureOutcome,
  type OpenAIStreamTerminationOutcome,
} from "./diagnostics.js";
import {
  collectOpenAIResponsesStream,
  forwardOpenAIResponsesStream,
  type OpenAIMessageOutputNormalizationDiagnostic,
} from "./protocol.js";
import { bindOpenAIResponseLifetime } from "./response-lifetime.js";
import { resolveOpenAIFunctionOutputName } from "./function-output.js";
import { requiresSingleMessageOutput } from "./message-output-policy.js";
import { fetchWithOpenAIReasoningFallback } from "./reasoning-fallback.js";
import { requestsOpenAIReasoningSummary } from "./reasoning-summary-options.js";
import { OpenAIResponseDisconnectionEvidence } from "./response-disconnection.js";
import { isProviderStreamDisconnectionError, PROVIDER_STREAM_DISCONNECTION } from "../../protocol/provider-stream-disconnection.js";

export async function invokeOpenAIResponses(
  params: ModelProviderInvocationParams,
  options: Readonly<{
    url: string;
    accessToken: string;
    payload: Record<string, unknown>;
    requireCompletedResponse?: boolean;
    assembleCompletedFunctionItems?: boolean;
    contextOverflowRecovery?: true;
  }>,
): Promise<ModelProviderInvocationResult> {
  const { payload } = options;
  const functionOutputName = resolveOpenAIFunctionOutputName(payload);
  const completionOptions = {
    functionOutputName,
    ...(options.contextOverflowRecovery ? { contextOverflowRecovery: true as const } : {}),
    ...(options.requireCompletedResponse ? { requireCompletedResponse: true } : {}),
    ...(options.assembleCompletedFunctionItems ? { assembleCompletedFunctionItems: true } : {}),
  };
  const presentationOptions = {
    ...completionOptions,
    reasoningSummary: requestsOpenAIReasoningSummary(params.invocation, payload),
  };
  const streamOptions = {
    ...presentationOptions,
    structuredOutput: requiresSingleMessageOutput(params.requestBody, payload),
    onMessageOutputDiagnostic: (diagnostic: OpenAIMessageOutputNormalizationDiagnostic) =>
      emitOpenAIMessageOutputDiagnostic(params, diagnostic),
  };
  const { result: { response, responseTrace, disconnectionEvidence }, issue } = await fetchWithOpenAIReasoningFallback({
    payload,
    requestBody: params.requestBody,
    invocation: params.invocation,
    abortSignal: params.abortSignal,
    onIssue: params.onIssue,
    operation: params.endpoint,
    send: async (attemptPayload) => {
      const disconnectionEvidence = new OpenAIResponseDisconnectionEvidence(params.abortSignal);
      const result = await fetchProviderWithTrace({
        endpoint: params.endpoint,
        requestBody: params.requestBody,
        invocation: params.invocation,
        fetchImpl: async (input, init) => bindOpenAIResponseLifetime(
          await params.fetchImpl(input, {
            ...init,
            ...(params.abortSignal ? { signal: params.abortSignal } : {}),
          }),
          { ...completionOptions, disconnectionEvidence },
        ),
        url: options.url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.accessToken}`,
        },
        payload: attemptPayload,
        decodeResponse: (body) => collectOpenAIResponsesStream(body, { ...presentationOptions, disconnectionEvidence }),
      });
      return { ...result, disconnectionEvidence };
    },
  });
  if (!response.ok || !response.body) {
    issue?.finish(params.abortSignal?.aborted ? "interrupted" : "failed");
    const message = await response.text();
    await responseTrace;
    const contextOverflow = readOpenAIHttpContextOverflow(response.status, message, options.contextOverflowRecovery);
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: toolMediaSafeMessage(message || "openai error", params.requestBody),
      ...(contextOverflow ? { contextOverflow } : {}),
    };
  }

  const streamStartedAt = Date.now();
  if (params.endpoint === "chat") {
    const body = response.body;
    return {
      kind: "chat",
      async stream(writer) {
        let outcome: OpenAIStreamTerminationOutcome = "completed";
        let failure: unknown;
        let completed = false;
        try {
          await forwardOpenAIResponsesStream(body, {
            emit: (event) => {
              if (event.type === "done" && !event.doneReason) completed = true;
              writer.emit(toolMediaSafeEvent(event, params.requestBody));
            },
          }, { ...streamOptions, disconnectionEvidence });
          issue?.finish(params.abortSignal?.aborted ? "interrupted" : completed ? "recovered" : "failed");
        } catch (error) {
          issue?.finish(params.abortSignal?.aborted ? "interrupted" : "failed");
          outcome = resolveOpenAIStreamFailureOutcome(error);
          failure = toolMediaSafeError(error, params.requestBody);
          if (!isProviderStreamDisconnectionError(error)) throw failure;
          writer.emit({
            type: "error",
            error: toolMediaSafeMessage(error instanceof Error ? error.message : "provider stream disconnected", params.requestBody),
            providerDisconnection: PROVIDER_STREAM_DISCONNECTION,
          });
        } finally {
          emitOpenAIStreamTermination({
            invocationParams: params, startedAt: streamStartedAt, outcome,
            ...(failure !== undefined ? { error: failure } : {}),
          });
          await responseTrace;
        }
      },
    };
  }

  let outcome: OpenAIStreamTerminationOutcome = "completed";
  let failure: unknown;
  try {
    const collected = await collectOpenAIResponsesStream(response.body, { ...streamOptions, disconnectionEvidence });
    issue?.finish(params.abortSignal?.aborted ? "interrupted" : collected.doneReason ? "failed" : "recovered");
    return {
      kind: "raw",
      body: {
        text: collected.text,
        thinking: collected.thinking,
        ...(collected.usage ? { usage: collected.usage } : {}),
        ...(collected.doneReason ? { providerCompletionReason: collected.doneReason } : {}),
      },
    };
  } catch (error) {
    issue?.finish(params.abortSignal?.aborted ? "interrupted" : "failed");
    outcome = resolveOpenAIStreamFailureOutcome(error);
    failure = toolMediaSafeError(error, params.requestBody);
    throw failure;
  } finally {
    emitOpenAIStreamTermination({
      invocationParams: params, startedAt: streamStartedAt, outcome,
      ...(failure !== undefined ? { error: failure } : {}),
    });
    await responseTrace;
  }
}
