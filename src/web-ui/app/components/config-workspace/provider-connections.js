import { textOf } from "../../lib/text-format.js";
import { isConfigObject } from "./config-model.js";

const fieldsByType = new Map([
  ["ollama", ["baseUrl", "keepAlive"]],
  ["llamacpp", ["baseUrl", "apiKeyEnv"]],
  ["openai", ["apiKeyEnv"]],
  ["openai-chatgpt", ["accountRef"]],
]);

export function providerEditFields(type) {
  return fieldsByType.get(type) || [];
}

/** The editor receives public connection settings and usage from the current dashboard. */
export function configuredProviderConnections(runtime, models) {
  const registry = runtime?.config?.models;
  if (!isConfigObject(registry?.providers)) return [];
  const embeddings = isConfigObject(registry.embeddingProfiles) ? Object.entries(registry.embeddingProfiles) : [];
  return Object.entries(registry.providers).filter(([, item]) => isConfigObject(item)).map(([id, item]) => {
    const type = textOf(item.type);
    const settings = {};
    for (const field of providerEditFields(type)) {
      const value = field === "accountRef" ? item.settings?.accountRef : item[field];
      settings[field] = typeof value === "string" ? value : "";
    }
    return {
      id, type, settings, expectedRevision: runtime.revision,
      modelIds: models.filter((model) => model.registered !== false && model.config?.provider === id).map((model) => model.id),
      embeddingIds: embeddings.filter(([, profile]) => profile?.provider === id).map(([key]) => key),
    };
  });
}

export function providerUsage(connection) {
  const kinds = [];
  if (connection.modelIds.length) kinds.push(`model profiles (${connection.modelIds.join(", ")})`);
  if (connection.embeddingIds.length) kinds.push(`embedding profiles (${connection.embeddingIds.join(", ")})`);
  return kinds.join(" and ");
}
