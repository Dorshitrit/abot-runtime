import { ChatGptAuthError, requireChatGptAccountRef } from "../../../provider-auth/chatgpt/contracts.js";
import type { ResolvedModelInvocation } from "../../types.js";

export const CHATGPT_RESPONSES_URL = "https://api.openai.com/v1/responses";

function hasConnectionOverride(value: Readonly<Record<string, unknown>>): boolean {
  return ["baseUrl", "baseURL", "apiKeyEnv", "apiKey"].some((key) => Object.hasOwn(value, key));
}

export function resolveChatGptAccountRef(invocation: ResolvedModelInvocation): string {
  const { providerConfig, options } = invocation.profile;
  if (!providerConfig || providerConfig.type !== "openai-chatgpt") {
    throw new ChatGptAuthError("chatgpt_provider_invalid", "Choose a ChatGPT provider profile.");
  }
  if (hasConnectionOverride(providerConfig) || hasConnectionOverride(options)) {
    throw new ChatGptAuthError("chatgpt_connection_override", "ChatGPT profiles cannot override the connection or use an API key.");
  }
  const settings = providerConfig.settings ?? {};
  if (Object.keys(settings).some((key) => key !== "accountRef")) {
    throw new ChatGptAuthError("chatgpt_settings_invalid", "ChatGPT provider settings must contain only an account reference.");
  }
  return requireChatGptAccountRef(settings.accountRef);
}
