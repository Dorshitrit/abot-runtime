function withProviderCredentialStatus(provider, catalog) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider))
    return provider;
  const { credentialConfigured: _previous, ...projected } = provider;
  const hasProviderIdentity =
    typeof provider.id === "string" && typeof provider.type === "string";
  if (!hasProviderIdentity) return projected;
  const matched = catalog.find(
    (entry) => entry?.id === provider.id && entry?.type === provider.type,
  );
  if (!matched) return projected;
  return {
    ...projected,
    credentialConfigured: matched.credentialConfigured === true,
  };
}

function withEmbeddingCredentialStatus(payload, catalog) {
  if (!Array.isArray(payload?.status?.providers)) return payload;
  return {
    ...payload,
    status: {
      ...payload.status,
      providers: payload.status.providers.map((provider) =>
        withProviderCredentialStatus(provider, catalog),
      ),
    },
  };
}

/** Reuse the Web UI catalog's safe credential flags without reading or retaining keys. */
export function createEmbeddingCredentialStatus({
  runtimeClient,
  getEnvironmentId,
}) {
  async function providerCatalog(environmentId) {
    try {
      const payload = await runtimeClient.loadModelSetup(environmentId);
      return Array.isArray(payload?.providers) ? payload.providers : [];
    } catch {
      return [];
    }
  }

  async function decorateSavedProviderError(error, environmentId) {
    if (error?.payload?.providerSaved !== true) return;
    if (!error.payload.savedProvider) return;
    const catalog = await providerCatalog(environmentId);
    const receipt = withProviderCredentialStatus(
      error.payload.savedProvider,
      catalog,
    );
    try {
      error.payload.savedProvider = receipt;
    } catch {
      // Frozen errors still retain their original identity and failure semantics.
    }
  }

  return {
    async loadStatus() {
      const environmentId = getEnvironmentId();
      const [payload, catalog] = await Promise.all([
        runtimeClient.loadLongTermMemoryStatus(environmentId),
        providerCatalog(environmentId),
      ]);
      return withEmbeddingCredentialStatus(payload, catalog);
    },
    async saveEmbedding(input) {
      const environmentId = getEnvironmentId();
      let payload;
      try {
        payload = await runtimeClient.saveRuntimeSetupEmbedding(
          input,
          environmentId,
        );
      } catch (error) {
        await decorateSavedProviderError(error, environmentId);
        throw error;
      }
      return withEmbeddingCredentialStatus(
        payload,
        await providerCatalog(environmentId),
      );
    },
  };
}
