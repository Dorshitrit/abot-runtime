import { RuntimeSetupError } from "../local-runtime/runtime-setup-input.js";
import { ModelSetupError } from "../local-runtime/model-setup-input.js";

/** Private save-path value only: never return this input in HTTP responses or logs. */
export type ReadyConfigurationConnection = Readonly<{
  baseUrl: string; model: string; contextWindowTokens: number; apiKey: string; revision?: string;
}>;
export type ConfigurationHandoff = (body: Record<string, unknown>) => Record<string, unknown>;
type SaveKind = "runtime" | "models";
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolves only explicit managed saves. No lifecycle, persistence or response ownership.
 * The getter must return the single owner's ready connection, or null when not ready.
 * Absent getter deliberately rejects managed input while leaving manual saves intact.
 */
export function createManagedLlamaHandoff(
  kind: SaveKind,
  readyConnectionForConfiguration?: (model?: string) => ReadyConfigurationConnection | null,
): ConfigurationHandoff {
  return (body) => {
    if (!owns(body, "managedLlama")) return body;
    const fail = (code: string, message: string, status = 400): never => {
      throw kind === "runtime"
        ? new RuntimeSetupError(code, message, status)
        : new ModelSetupError(code, message, status);
    };
    if (body.managedLlama !== true)
      fail("invalid_managed_llama", "The managed llama.cpp option must be true.");
    const provider = record(body.newProvider) ? body.newProvider : undefined;
    if (kind === "runtime" ? body.provider !== "llamacpp"
      : owns(body, "providerId") || provider?.type !== "llamacpp")
      fail("invalid_managed_llama_provider", "Choose a new llama.cpp connection for the managed engine.");
    let ready: ReadyConfigurationConnection | null = null;
    try { ready = readyConnectionForConfiguration?.(typeof body.model === "string" ? body.model : undefined) ?? null; }
    catch { /* Dependency details may contain credentials; never forward them. */ }
    if (!ready || typeof ready.baseUrl !== "string" || !ready.baseUrl ||
      typeof ready.model !== "string" || !ready.model ||
      !Number.isSafeInteger(ready.contextWindowTokens) || ready.contextWindowTokens <= 0 ||
      typeof ready.apiKey !== "string" || !ready.apiKey)
      return fail("managed_llama_not_ready", "Start the managed llama.cpp engine and wait until it is ready before saving.", 409);
    const connection = ready;
    if (connection.revision !== undefined && body.managedLlamaRevision !== connection.revision)
      fail("managed_llama_conflict", "The managed server settings changed. Select the model again.", 409);
    const check = (input: Record<string, unknown>, field: string, expected: unknown) => {
      if (owns(input, field) && input[field] !== expected)
        fail("managed_llama_conflict", "Supplied connection settings conflict with the ready managed engine.");
    };
    check(body, "apiKey", connection.apiKey);
    check(body, "model", connection.model);
    check(body, "contextWindowTokens", connection.contextWindowTokens);
    check(body, "baseUrl", connection.baseUrl);
    if (kind === "models") {
      check(provider!, "baseUrl", connection.baseUrl);
      check(provider!, "useApiKey", true);
    }
    const result = { ...body };
    delete result.managedLlama;
    delete result.managedLlamaRevision;
    Object.assign(result, { model: connection.model, contextWindowTokens: connection.contextWindowTokens,
      apiKey: connection.apiKey });
    if (kind === "runtime") result.baseUrl = connection.baseUrl;
    else {
      // Models addresses belong inside newProvider, not at the top level.
      delete result.baseUrl;
      result.newProvider = { ...provider, baseUrl: connection.baseUrl, useApiKey: true };
    }
    return result;
  };
}
