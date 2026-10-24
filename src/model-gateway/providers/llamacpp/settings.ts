import type { ModelGatewayProviderConfig } from "../../types.js";

export function resolveLlamaCppUrls(baseUrl: string): { apiUrl: string; serverUrl: string } {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("llamacpp_base_url_invalid");
  }
  const root = url.toString().replace(/\/+$/, "");
  const serverUrl = root.endsWith("/v1") ? root.slice(0, -3) : root;
  return { serverUrl, apiUrl: `${serverUrl}/v1` };
}

export function resolveLlamaCppProviderSettings(config?: ModelGatewayProviderConfig): {
  apiUrl: string; headers: Record<string, string>;
} {
  if (!config?.baseUrl?.trim()) throw new TypeError("llamacpp_base_url_required");
  const { apiUrl } = resolveLlamaCppUrls(config.baseUrl.trim());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKeyEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) {
      throw new TypeError("llamacpp_api_key_env_invalid");
    }
    const apiKey = process.env[config.apiKeyEnv]?.trim();
    if (!apiKey) throw new TypeError(`missing llama.cpp API key env: ${config.apiKeyEnv}`);
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return { apiUrl, headers };
}
