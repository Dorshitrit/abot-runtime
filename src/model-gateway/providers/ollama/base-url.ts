export function resolveConfiguredOllamaBaseUrl(
  configuredUrl: string | undefined,
  fallbackUrl: string,
): string {
  const effectiveUrl = configuredUrl?.trim() || fallbackUrl.trim();
  return effectiveUrl.replace(/\/+$/u, "");
}
