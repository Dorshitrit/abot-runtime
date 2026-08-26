import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../../types.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
}

function resolveApiKeyEnvironment(requestBody: ModelGatewayRequest): string {
  const invocation = resolveModelInvocation(requestBody);
  const configuredName =
    invocation.profile.providerConfig?.apiKeyEnv?.trim() ||
    DEFAULT_OPENAI_API_KEY_ENV;
  return ENV_VAR_NAME_PATTERN.test(configuredName)
    ? configuredName
    : DEFAULT_OPENAI_API_KEY_ENV;
}

export function resolveOpenAIProviderSettings(
  requestBody: ModelGatewayRequest,
): {
  baseUrl: string;
  apiKeyEnv: string;
  apiKey?: string;
} {
  const invocation = resolveModelInvocation(requestBody);
  const apiKeyEnv = resolveApiKeyEnvironment(requestBody);
  const apiKey = process.env[apiKeyEnv];
  return {
    baseUrl: normalizeBaseUrl(
      invocation.profile.providerConfig?.baseUrl ?? process.env.OPENAI_BASE_URL,
    ),
    apiKeyEnv,
    ...(apiKey ? { apiKey } : {}),
  };
}
