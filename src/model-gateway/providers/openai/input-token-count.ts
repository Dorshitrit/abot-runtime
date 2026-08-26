import type {
  ModelProviderInputTokenCountParams,
  ModelProviderInputTokenCountResult,
} from "../contracts.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { buildOpenAIInputTokenCountPayload } from "./payload.js";
import { resolveOpenAIProviderSettings } from "./settings.js";

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

  const payload = buildOpenAIInputTokenCountPayload(params.requestBody);
  const response = await params.fetchImpl(
    `${settings.baseUrl}/responses/input_tokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: message || "openai input token count error",
    };
  }

  const body = await response.json().catch(() => undefined);
  const inputTokens = readInputTokenCount(body);
  if (inputTokens === undefined) {
    return {
      kind: "error",
      statusCode: 502,
      message: "openai input token count response invalid",
    };
  }
  return {
    kind: "counted",
    inputTokens,
    providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(payload),
  };
}
