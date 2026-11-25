import type {
  ModelProviderInputTokenCountParams,
  ModelProviderInputTokenCountResult,
} from "../contracts.js";
import { observeParameterOmissions } from "../parameter-issues.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { buildOpenAIInputTokenCountPayload } from "./payload.js";
import { resolveOpenAIProviderSettings } from "./settings.js";
import { fetchWithOpenAIReasoningFallback } from "./reasoning-fallback.js";
import { toolMediaSafeError, toolMediaSafeMessage } from "../../observability/tool-media-privacy.js";

function readInputTokenCount(body: unknown): number | undefined {
  const isRecord =
    body !== null && typeof body === "object" && !Array.isArray(body);
  if (!isRecord) {
    return undefined;
  }
  const inputTokens = (body as Record<string, unknown>).input_tokens;
  const isValidCount =
    typeof inputTokens === "number" &&
    Number.isSafeInteger(inputTokens) &&
    inputTokens >= 0;
  return isValidCount ? inputTokens : undefined;
}

export async function countOpenAIInputTokens(
  params: ModelProviderInputTokenCountParams,
): Promise<ModelProviderInputTokenCountResult> {
  const settings = resolveOpenAIProviderSettings(params.requestBody);
  if (!settings.apiKey) {
    return {
      kind: "error",
      statusCode: 500,
      message: `missing OpenAI API key env: ${settings.apiKeyEnv}`,
    };
  }

  const originalPayload = buildOpenAIInputTokenCountPayload(params.requestBody);
  observeParameterOmissions({ ...params, operation: "input_tokens" });
  const { result: { response }, payload, issue } = await fetchWithOpenAIReasoningFallback({
    payload: originalPayload,
    requestBody: params.requestBody,
    invocation: params.invocation,
    abortSignal: params.abortSignal,
    onIssue: params.onIssue,
    operation: "input_tokens",
    send: async (attemptPayload) => ({
      response: await params.fetchImpl(`${settings.baseUrl}/responses/input_tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(attemptPayload),
        signal: params.abortSignal,
      }),
    }),
  }).catch((error) => { throw toolMediaSafeError(error, params.requestBody); });
  if (!response.ok) {
    issue?.finish(params.abortSignal?.aborted ? "interrupted" : "failed");
    const message = await response.text().catch(() => "");
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: toolMediaSafeMessage(message || "openai input token count error", params.requestBody),
    };
  }

  const body = await response.json().catch(() => undefined);
  const inputTokens = readInputTokenCount(body);
  if (inputTokens === undefined) {
    issue?.finish(params.abortSignal?.aborted ? "interrupted" : "failed");
    return {
      kind: "error",
      statusCode: 502,
      message: "openai input token count response invalid",
    };
  }
  issue?.finish(params.abortSignal?.aborted ? "interrupted" : "recovered");
  return {
    kind: "counted",
    inputTokens,
    providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(payload),
  };
}
