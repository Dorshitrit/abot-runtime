export function supportsProviderAddress(provider: string): boolean {
  return provider === "ollama" || provider === "llamacpp";
}

export function defaultProviderAddress(provider: string): string | undefined {
  if (provider === "ollama") return "http://127.0.0.1:11434";
  if (provider === "llamacpp") return "http://127.0.0.1:8080";
  return undefined;
}

export function supportsProviderCredential(provider: string): boolean {
  return provider === "openai" || provider === "llamacpp";
}

export function parseProviderCredentialEnvironment(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    return value;
  throw new Error("API key environment name must be a valid environment variable name.");
}
