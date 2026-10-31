import { isolatedProviderCredentialName } from "./provider-credential-identity.js";
import { isRecord } from "../../runtime/config/utils.js";

export function resolveRuntimeSetupCredentialEnvironment(
  provider: string,
  savedProvider: unknown,
  apiKey?: string,
): string | undefined {
  if (provider === "ollama" || provider === "openai-chatgpt") return undefined;
  if (isRecord(savedProvider) && typeof savedProvider.apiKeyEnv === "string")
    return savedProvider.apiKeyEnv;
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "llamacpp" && apiKey)
    return isolatedProviderCredentialName(provider);
  return undefined;
}

export function requiresProviderCredential(provider: unknown): boolean {
  if (!isRecord(provider)) return false;
  if (provider.type === "openai") return true;
  return provider.type === "llamacpp" && typeof provider.apiKeyEnv === "string";
}
