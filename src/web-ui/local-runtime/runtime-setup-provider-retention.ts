import { setupConfigMap } from "./runtime-setup-draft.js";

function embeddingReferencesProvider(
  embeddingProfiles: unknown,
  providerId: string,
): boolean {
  return Object.values(setupConfigMap(embeddingProfiles)).some((profile) => {
    const provider = setupConfigMap(profile).provider;
    return typeof provider === "string" && provider.trim() === providerId;
  });
}

function canRemoveAbandonedSetupProvider(
  providerId: string,
  selectedProviderId: string,
  embeddingProfiles: unknown,
): boolean {
  if (providerId === selectedProviderId) return false;
  return !embeddingReferencesProvider(embeddingProfiles, providerId);
}

/** The current draft owns the sole chat profile; embeddings may still use its old providers. */
export function retainSetupConnectionProviders(params: {
  providers: Record<string, unknown>;
  ownedProviders: Record<string, unknown>;
  embeddingProfiles: unknown;
  providerId: string;
  provider: Record<string, unknown>;
}): {
  providers: Record<string, unknown>;
  ownedProviders: Record<string, unknown>;
} {
  const providers = {
    ...params.providers,
    [params.providerId]: params.provider,
  };
  const ownedProviders = { ...params.ownedProviders };
  const selectedProviderIsOwned = Object.hasOwn(
    ownedProviders,
    params.providerId,
  );
  const selectedProviderIsNew = !Object.hasOwn(
    params.providers,
    params.providerId,
  );
  if (selectedProviderIsOwned || selectedProviderIsNew)
    ownedProviders[params.providerId] = params.provider;
  for (const providerId of Object.keys(ownedProviders)) {
    if (
      !canRemoveAbandonedSetupProvider(
        providerId,
        params.providerId,
        params.embeddingProfiles,
      )
    ) continue;
    delete providers[providerId];
    delete ownedProviders[providerId];
  }
  return { providers, ownedProviders };
}
