import { parseBaseUrl } from "../../../scripts/runtime-setup-files.js";
import { inspectLlamaCppConnection } from "../../model-gateway/providers/llamacpp/connection.js";
import { inspectRuntimeConfigFileWithMeta } from "../../runtime/config/loader.js";
import { isRecord } from "../../runtime/config/utils.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import { readRuntimeSetupCredential } from "./runtime-setup-credentials.js";

function inputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiresSafeInspectionCredential(value: string): void {
  if (value.length <= 4096 && !/[\u0000-\u0020\u007f'"`]/u.test(value)) return;
  throw new RuntimeSetupError("invalid_connection_credential", "The API key contains unsupported characters.");
}

/** Explicit inspection reads metadata only and never saves settings or invokes a model. */
export async function inspectModelSetupConnection(
  options: { rootDir: string; configPath?: string },
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const source = inspectRuntimeConfigFileWithMeta(options.rootDir, options.configPath);
  const models = isRecord(source.config.models) ? source.config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  const providerId = inputText(body.providerId);
  const configured = providers[providerId || "llamacpp"];
  const saved = isRecord(configured) ? configured : undefined;
  if (providerId && saved?.type !== "llamacpp")
    throw new RuntimeSetupError("unsupported_connection_inspection", "Choose a saved llama.cpp connection.");
  if (!providerId && body.provider !== "llamacpp")
    throw new RuntimeSetupError("unsupported_connection_inspection", "Connection inspection is available for llama.cpp.");
  let baseUrl: string;
  try {
    baseUrl = parseBaseUrl(inputText(providerId ? saved?.baseUrl : body.baseUrl));
  } catch {
    throw new RuntimeSetupError("invalid_connection_address", "Enter an HTTP or HTTPS origin without a path or credentials.");
  }
  const suppliedKey = inputText(body.apiKey);
  requiresSafeInspectionCredential(suppliedKey);
  const canReuseSavedCredential = saved?.type === "llamacpp" && saved.baseUrl === baseUrl;
  const apiKeyEnv = canReuseSavedCredential && typeof saved.apiKeyEnv === "string"
    ? saved.apiKeyEnv : undefined;
  const apiKey = suppliedKey || (apiKeyEnv ? readRuntimeSetupCredential(options.rootDir, apiKeyEnv) : "");
  if (apiKeyEnv && !apiKey)
    throw new RuntimeSetupError("connection_credential_required", "Enter the API key configured for this connection.");
  try {
    return await inspectLlamaCppConnection({ baseUrl, ...(apiKey ? { apiKey } : {}), signal });
  } catch {
    throw new RuntimeSetupError("model_connection_unavailable", "Could not inspect this llama.cpp server. Check its address, authentication and whether its model is loaded.", 502);
  }
}
