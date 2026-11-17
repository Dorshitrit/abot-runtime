/** Shared catalog feedback for first-run setup and Memory settings. */
export function describeEmbeddingModelDiscovery(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  if (catalog?.supported !== true)
    return { models, message: "This provider does not list models. Enter an embedding model ID." };
  const result = models.length === 1
    ? "The provider lists one embedding model."
    : `The provider lists ${models.length} embedding models.`;
  const unverified = Array.isArray(catalog.unverifiedModels) ? catalog.unverifiedModels : [];
  const message = unverified.length
    ? `${result} Embedding support is unknown for ${unverified.join(", ")}. You can enter a model ID manually.`
    : result;
  return { models, message };
}
