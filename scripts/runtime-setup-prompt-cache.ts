/** Setup owns the explicit profile choice; gateway support is checked at invocation. */
export function parseSetupPromptCache(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new Error("Optimize prompt caching must be true or false.");
  return value;
}

export function requireSetupPromptCacheProvider(provider: string, enabled: boolean | undefined): void {
  if (enabled !== true) return;
  if (provider === "openai") return;
  throw new Error("Optimize prompt caching requires an OpenAI API provider.");
}

/** Keep unrelated options; omission preserves a saved choice on the same provider. */
export function applySetupPromptCache(
  profile: Record<string, unknown>,
  provider: string,
  enabled: boolean | undefined,
): void {
  requireSetupPromptCacheProvider(provider, enabled);
  const previous = profile.options;
  const options = previous && typeof previous === "object" && !Array.isArray(previous)
    ? { ...previous } as Record<string, unknown> : {};
  if (provider !== "openai" || enabled === false) delete options.prompt_cache_options;
  if (enabled === true) options.prompt_cache_options = { mode: "implicit" };
  if (Object.keys(options).length > 0) {
    profile.options = options;
    return;
  }
  delete profile.options;
}
