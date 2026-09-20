import { setupConfigMap } from "./runtime-setup-draft.js";

function selectedEnabledEmbeddingProvider(
  config: Record<string, unknown>,
): string | undefined {
  const memory = setupConfigMap(config.longTermMemory);
  if (memory.enabled !== true) return undefined;
  if (typeof memory.embeddingProfileId !== "string") return undefined;
  const models = setupConfigMap(config.models);
  const profiles = setupConfigMap(models.embeddingProfiles);
  const profileId = memory.embeddingProfileId.trim();
  const provider = setupConfigMap(profiles[profileId]).provider;
  if (typeof provider !== "string") return undefined;
  return provider.trim() || undefined;
}

function openAICredentialBinding(
  provider: Record<string, unknown>,
): string | undefined {
  if (provider.type !== "openai") return undefined;
  const configured =
    typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(configured)) return "OPENAI_API_KEY";
  return configured;
}

/** Credentials may be shared by provider aliases; addresses belong to one provider. */
export function shouldInvalidateSetupEmbedding(params: {
  config: Record<string, unknown>;
  providerId: string;
  provider: Record<string, unknown>;
  providerChanged: boolean;
  credentialChanged: boolean;
}): boolean {
  const selectedProviderId = selectedEnabledEmbeddingProvider(params.config);
  if (!selectedProviderId) return false;
  if (selectedProviderId === params.providerId)
    return params.providerChanged || params.credentialChanged;
  if (!params.credentialChanged) return false;
  const changedBinding = openAICredentialBinding(params.provider);
  if (!changedBinding) return false;
  const models = setupConfigMap(params.config.models);
  const providers = setupConfigMap(models.providers);
  const selectedProvider = setupConfigMap(providers[selectedProviderId]);
  return openAICredentialBinding(selectedProvider) === changedBinding;
}
