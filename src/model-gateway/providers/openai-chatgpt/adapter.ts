import { ChatGptAuthError } from "../../../provider-auth/chatgpt/contracts.js";
import { getChatGptAuthService } from "../../../provider-auth/chatgpt/service.js";
import type { ModelProviderAdapter } from "../contracts.js";
import { emitOpenAISchemaDiagnostics } from "../openai/diagnostics.js";
import { invokeOpenAIResponses } from "../openai/responses-invocation.js";
import { buildChatGptResponsesPayload } from "./payload.js";
import { CHATGPT_RESPONSES_URL, resolveChatGptAccountRef } from "./settings.js";

export function createChatGptProviderAdapter(options: Readonly<{
  getAccessToken?: (accountRef: string, signal?: AbortSignal) => Promise<string>;
}> = {}): ModelProviderAdapter {
  const getAccessToken = options.getAccessToken ?? ((accountRef, signal) =>
    getChatGptAuthService().getAccessToken(accountRef, signal));
  return Object.freeze({
    type: "openai-chatgpt",
    supportsImageInput: true,
    async invoke(params) {
      params.abortSignal?.throwIfAborted();
      let accessToken: string;
      try {
        const accountRef = resolveChatGptAccountRef(params.invocation);
        accessToken = await getAccessToken(accountRef, params.abortSignal);
      } catch (error) {
        params.abortSignal?.throwIfAborted();
        if (!(error instanceof ChatGptAuthError)) throw error;
        return { kind: "error", statusCode: error.statusCode, message: error.message };
      }
      params.abortSignal?.throwIfAborted();
      const requestId = typeof params.requestBody.debugRequestId === "string"
        ? params.requestBody.debugRequestId : "";
      const payload = buildChatGptResponsesPayload(params.requestBody, {
        onFormatProjection: (diagnostics) => emitOpenAISchemaDiagnostics(requestId, diagnostics, "openai-chatgpt"),
      });
      return invokeOpenAIResponses({
        ...params,
        fetchImpl: (input, init) => params.fetchImpl(input, { ...init, redirect: "error" }),
      }, {
        url: CHATGPT_RESPONSES_URL, accessToken, payload, requireCompletedResponse: true,
        assembleCompletedFunctionItems: true,
        contextOverflowRecovery: true,
      });
    },
  });
}
