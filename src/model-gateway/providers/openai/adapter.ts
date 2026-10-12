import { fetchProviderWithTrace } from "../../model-io-trace.js";
import { toolMediaSafeError, toolMediaSafeEvent, toolMediaSafeMessage } from "../../observability/tool-media-privacy.js";
import type { ModelProviderAdapter } from "../contracts.js";
import {
  emitOpenAIMessageOutputDiagnostic,
  emitOpenAISchemaDiagnostics,
  emitOpenAIStreamTermination,
  resolveOpenAIStreamFailureOutcome,
  type OpenAIStreamTerminationOutcome,
} from "./diagnostics.js";
import { countOpenAIInputTokens } from "./input-token-count.js";
import {
  buildOpenAIResponsesPayload,
  collectOpenAIResponsesStream,
  forwardOpenAIResponsesStream,
  resolveOpenAIProviderSettings,
  type OpenAIMessageOutputNormalizationDiagnostic,
} from "./protocol.js";
import { embedWithOpenAI } from "./embeddings.js";
import { bindOpenAIResponseLifetime } from "./response-lifetime.js";
import { resolveOpenAIFunctionOutputName } from "./function-output.js";
import { requiresSingleMessageOutput } from "./message-output-policy.js";

export function createOpenAIProviderAdapter(): ModelProviderAdapter {
  return Object.freeze({
    type: "openai",
    supportsImageInput: true,
    embed: embedWithOpenAI,
    countInputTokens: countOpenAIInputTokens,
    async invoke(params) {
      const settings = resolveOpenAIProviderSettings(params.requestBody);
      if (!settings.apiKey) {
        return {
          kind: "error" as const,
          statusCode: 500,
          message: `missing OpenAI API key env: ${settings.apiKeyEnv}`,
        };
      }

      const requestId =
        typeof params.requestBody.debugRequestId === "string"
          ? params.requestBody.debugRequestId
          : "";
      const payload = buildOpenAIResponsesPayload(params.requestBody, {
        onFormatProjection: (diagnostics) =>
          emitOpenAISchemaDiagnostics(requestId, diagnostics),
      });
      const functionOutputName = resolveOpenAIFunctionOutputName(payload);
      const streamOptions = {
        functionOutputName,
        structuredOutput: requiresSingleMessageOutput(params.requestBody, payload),
        onMessageOutputDiagnostic: (
          diagnostic: OpenAIMessageOutputNormalizationDiagnostic,
        ) => emitOpenAIMessageOutputDiagnostic(params, diagnostic),
      };
      const { response, responseTrace } = await fetchProviderWithTrace({
        endpoint: params.endpoint,
        requestBody: params.requestBody,
        invocation: params.invocation,
        fetchImpl: async (input, init) => bindOpenAIResponseLifetime(
          await params.fetchImpl(input, init),
          { functionOutputName },
        ),
        url: `${settings.baseUrl}/responses`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        payload,
        decodeResponse: (body) => collectOpenAIResponsesStream(body, { functionOutputName }),
      });
      if (!response.ok || !response.body) {
        const message = await response.text();
        await responseTrace;
        return {
          kind: "error" as const,
          statusCode: response.status || 502,
          message: toolMediaSafeMessage(message || "openai error", params.requestBody),
        };
      }

      const streamStartedAt = Date.now();
      if (params.endpoint === "chat") {
        const body = response.body;
        return {
          kind: "chat" as const,
          async stream(writer) {
            let outcome: OpenAIStreamTerminationOutcome = "completed";
            let failure: unknown;
            try {
              await forwardOpenAIResponsesStream(body, {
                emit: (event) => writer.emit(toolMediaSafeEvent(event, params.requestBody)),
              }, streamOptions);
            } catch (error) {
              outcome = resolveOpenAIStreamFailureOutcome(error);
              failure = toolMediaSafeError(error, params.requestBody);
              throw failure;
            } finally {
              emitOpenAIStreamTermination({
                invocationParams: params,
                startedAt: streamStartedAt,
                outcome,
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
        const collected = await collectOpenAIResponsesStream(
          response.body,
          streamOptions,
        );
        return {
          kind: "raw" as const,
          body: {
            text: collected.text,
            thinking: collected.thinking,
            ...(collected.usage ? { usage: collected.usage } : {}),
            ...(collected.doneReason
              ? { providerCompletionReason: collected.doneReason }
              : {}),
          },
        };
      } catch (error) {
        outcome = resolveOpenAIStreamFailureOutcome(error);
        failure = toolMediaSafeError(error, params.requestBody);
        throw failure;
      } finally {
        emitOpenAIStreamTermination({
          invocationParams: params,
          startedAt: streamStartedAt,
          outcome,
          ...(failure !== undefined ? { error: failure } : {}),
        });
        await responseTrace;
      }
    },
  });
}
