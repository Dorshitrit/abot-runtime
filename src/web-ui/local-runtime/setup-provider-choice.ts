/** Provider choices supported by the local Web setup workflows. */
export type WebSetupProvider =
  | "openai"
  | "openai-chatgpt"
  | "ollama"
  | "llamacpp";

export function isWebSetupProvider(value: string): value is WebSetupProvider {
  return ["openai", "openai-chatgpt", "ollama", "llamacpp"].includes(value);
}
