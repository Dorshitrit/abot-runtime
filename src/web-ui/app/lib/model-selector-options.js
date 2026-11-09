import { modelProfileLabels } from "./model-profile-labels.js";
import { textOf } from "./text-format.js";

const providerNames = new Map([
  ["ollama", "Ollama"],
  ["llamacpp", "llama.cpp"],
  ["openai", "OpenAI"],
  ["openai-chatgpt", "ChatGPT"],
]);

/** Keep configured connections distinct while preserving catalog order. */
export function groupModelSelectorOptions(options) {
  const groups = new Map();
  for (const option of options) {
    const id = option.providerId || "";
    if (!groups.has(id)) {
      groups.set(id, { id, label: option.providerLabel || "", options: [] });
    }
    groups.get(id).options.push(option);
  }
  return [...groups.values()];
}

/** Display metadata only: values remain the original saved profile IDs. */
export function modelSelectorOptions(profiles) {
  const normalized = profiles.map((profile) => ({
    ...profile,
    provider: textOf(profile.provider).trim(),
    providerId: textOf(profile.providerId).trim() || textOf(profile.provider).trim(),
  }));
  const groups = groupModelSelectorOptions(normalized);
  const connectionsByType = new Map();
  for (const group of groups) {
    const type = group.options[0].provider;
    connectionsByType.set(type, (connectionsByType.get(type) || 0) + 1);
  }
  const presentation = new Map();
  for (const group of groups) {
    const type = group.options[0].provider;
    const providerName = providerNames.get(type) || type || group.id;
    const providerLabel = connectionsByType.get(type) > 1 && type
      ? `${providerName} · ${group.id}`
      : providerName;
    const labels = modelProfileLabels(group.options);
    for (const profile of group.options) {
      presentation.set(profile.id, {
        value: profile.id,
        label: labels.get(profile.id),
        providerId: group.id,
        providerLabel,
        usingChatgptPlan: type === "openai-chatgpt",
        ...(typeof profile.executionPolicy === "string" ? { executionPolicy: profile.executionPolicy } : {}),
      });
    }
  }
  return profiles.map((profile) => presentation.get(profile.id));
}
