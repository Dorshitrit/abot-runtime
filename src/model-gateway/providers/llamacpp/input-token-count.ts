import { toolMediaSafeError, toolMediaSafeMessage } from "../../observability/tool-media-privacy.js";
import type {
  ModelProviderInputTokenCountParams,
  ModelProviderInputTokenCountResult,
} from "../contracts.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { buildLlamaCppChatPayload } from "./payload.js";
import { resolveLlamaCppProviderSettings } from "./settings.js";

function readLlamaCppInputTokenCount(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const count = (value as Record<string, unknown>).input_tokens;
  return isLlamaCppInputTokenCount(count) ? count : undefined;
}

function isLlamaCppInputTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Counts the identical chat envelope through llama.cpp's non-generating native endpoint. */
export async function countLlamaCppInputTokens(
  params: ModelProviderInputTokenCountParams,
): Promise<ModelProviderInputTokenCountResult> {
  let settings: ReturnType<typeof resolveLlamaCppProviderSettings>;
  try {
    settings = resolveLlamaCppProviderSettings(params.invocation.profile.providerConfig);
  } catch (error) {
    return {
      kind: "error",
      statusCode: 500,
      message: toolMediaSafeMessage(
        error instanceof Error ? error.message : "llamacpp_configuration_invalid",
        params.requestBody,
      ),
    };
  }
  const payload = buildLlamaCppChatPayload(params);
  const response = await params.fetchImpl(`${settings.apiUrl}/chat/completions/input_tokens`, {
    method: "POST",
    headers: settings.headers,
    body: JSON.stringify(payload),
  }).catch((error: unknown) => { throw toolMediaSafeError(error, params.requestBody); });
  if (!response.ok) {
    const message = await response.text();
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: toolMediaSafeMessage(message || "llamacpp input token count error", params.requestBody),
    };
  }
  const body = await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  });
  const inputTokens = readLlamaCppInputTokenCount(body);
  if (inputTokens === undefined) {
    return {
      kind: "error",
      statusCode: 502,
      message: "llamacpp input token count response invalid",
    };
  }
  return {
    kind: "counted",
    inputTokens,
    providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(payload),
  };
}
