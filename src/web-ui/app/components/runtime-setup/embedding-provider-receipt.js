function isSavedEmbeddingProviderReceipt(payload, selection) {
  if (payload?.providerSaved !== true) return false;
  const receipt = payload.savedProvider;
  if (!receipt || typeof receipt !== "object") return false;
  if (Array.isArray(receipt)) return false;
  if (typeof receipt.id !== "string") return false;
  if (!receipt.id.trim() || receipt.id !== receipt.id.trim()) return false;
  if (typeof receipt.type !== "string" || !receipt.type.trim()) return false;
  if (receipt.type !== selection.type) return false;
  if (selection.providerId) return receipt.id === selection.providerId;
  return true;
}

/** Project only the canonical identity returned after a completed provider save. */
export function applySavedEmbeddingProviderReceipt(state, payload, selection) {
  if (!isSavedEmbeddingProviderReceipt(payload, selection)) return;
  const { id, type } = payload.savedProvider;
  const receipt = { id, type };
  const hasCredentialStatus =
    typeof payload.savedProvider.credentialConfigured === "boolean";
  if (hasCredentialStatus)
    receipt.credentialConfigured = payload.savedProvider.credentialConfigured;
  const existing = state.providers.find((provider) => provider.id === id);
  const providers = state.providers.map((provider) =>
    provider.id === id ? { ...provider, ...receipt } : provider,
  );
  if (!existing) providers.push(receipt);
  state.providers = providers;
  state.provider = id;
}
