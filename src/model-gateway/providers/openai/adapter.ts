import type { ModelProviderAdapter } from "../contracts.js";
import { emitOpenAISchemaDiagnostics } from "./diagnostics.js";
import { countOpenAIInputTokens } from "./input-token-count.js";
import {
  buildOpenAIResponsesPayload,
  resolveOpenAIProviderSettings,
} from "./protocol.js";
import { embedWithOpenAI } from "./embeddings.js";
import { invokeOpenAIResponses } from "./responses-invocation.js";

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
      return invokeOpenAIResponses(params, {
        url: `${settings.baseUrl}/responses`,
        accessToken: settings.apiKey,
        payload,
      });
    },
  });
}
