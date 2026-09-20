import type { RuntimeSetupInput } from "./runtime-setup-input.js";
import type { configuredSetupModel } from "./runtime-setup-provider.js";
import { readRuntimeSetupCredential } from "./runtime-setup-credentials.js";

/** A revisionless retry can fill a missing credential, never edit its connection. */
export function canCompleteMissingRuntimeSetupCredential(
  existing: ReturnType<typeof configuredSetupModel>,
  input: RuntimeSetupInput,
  rootDir: string,
): boolean {
  if (!existing) return false;
  if (input.connectionRevision !== undefined) return false;
  if (existing.provider !== "openai") return false;
  if (input.provider !== existing.provider) return false;
  if (existing.model.trim() !== input.model.trim()) return false;
  const requestedContext =
    input.contextWindowTokens ?? existing.contextWindowTokens;
  if (requestedContext !== existing.contextWindowTokens) return false;
  // Both projections already normalize addresses to origins.
  if ((existing.baseUrl ?? "") !== (input.baseUrl ?? "")) return false;
  return !readRuntimeSetupCredential(rootDir, existing.apiKeyEnv);
}
