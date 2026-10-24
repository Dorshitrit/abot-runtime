import { fetchProviderWithTrace } from "../../model-io-trace.js";
import { toolMediaSafeError, toolMediaSafeEvent, toolMediaSafeMessage } from "../../observability/tool-media-privacy.js";
import type { ModelProviderAdapter } from "../contracts.js";
import { emitLlamaCppStreamTermination } from "./diagnostics.js";
import { embedWithLlamaCpp } from "./embeddings.js";
import { countLlamaCppInputTokens } from "./input-token-count.js";
import { buildLlamaCppChatPayload } from "./payload.js";
import { bindLlamaCppResponseLifetime } from "./response-lifetime.js";
import { resolveLlamaCppProviderSettings } from "./settings.js";
import { collectLlamaCppChatStream, forwardLlamaCppChatStream } from "./stream.js";

export function createLlamaCppProviderAdapter(): ModelProviderAdapter {
  return Object.freeze({
    type: "llamacpp",
    supportsImageInput: false,
    embed: embedWithLlamaCpp,
    countInputTokens: countLlamaCppInputTokens,
    async invoke(params) {
      let settings: ReturnType<typeof resolveLlamaCppProviderSettings>;
      try { settings = resolveLlamaCppProviderSettings(params.invocation.profile.providerConfig); }
      catch (error) {
        return { kind: "error" as const, statusCode: 500, message: toolMediaSafeMessage(
          error instanceof Error ? error.message : "llamacpp_configuration_invalid", params.requestBody,
        ) };
      }
      const payload = buildLlamaCppChatPayload(params);
      const { response, responseTrace } = await fetchProviderWithTrace({
        endpoint: params.endpoint, requestBody: params.requestBody, invocation: params.invocation,
        fetchImpl: async (input, init) => bindLlamaCppResponseLifetime(await params.fetchImpl(input, init)),
        url: `${settings.apiUrl}/chat/completions`, headers: settings.headers, payload,
        decodeResponse: collectLlamaCppChatStream,
      });
      if (!response.ok || !response.body) {
        const message = await response.text();
        await responseTrace;
        return { kind: "error" as const, statusCode: response.ok ? 502 : response.status,
          message: toolMediaSafeMessage(message || "llamacpp error", params.requestBody) };
      }
      const startedAt = Date.now();
      const body = response.body;
      if (params.endpoint === "chat") {
        return {
          kind: "chat" as const,
          async stream(writer) {
            let failure: unknown;
            try {
              await forwardLlamaCppChatStream(body, {
                emit: (event) => writer.emit(toolMediaSafeEvent(event, params.requestBody)),
              });
            } catch (error) {
              failure = toolMediaSafeError(error, params.requestBody);
              throw failure;
            } finally {
              emitLlamaCppStreamTermination(params, startedAt, failure);
              await responseTrace;
            }
          },
        };
      }
      let failure: unknown;
      try {
        const result = await collectLlamaCppChatStream(body);
        return { kind: "raw" as const, body: {
          text: result.text, thinking: result.thinking,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.doneReason ? { providerCompletionReason: result.doneReason } : {}),
        } };
      } catch (error) {
        failure = toolMediaSafeError(error, params.requestBody);
        throw failure;
      } finally {
        emitLlamaCppStreamTermination(params, startedAt, failure);
        await responseTrace;
      }
    },
  });
}
