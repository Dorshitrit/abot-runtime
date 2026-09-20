import { RuntimeSetupError } from "./runtime-setup-input.js";
import {
  hasProviderCredentialBinding,
  isolatedProviderCredentialName,
} from "./provider-credential-identity.js";
import { buildProviderConfig } from "../../../scripts/runtime-setup-files.js";
import { isRecord } from "../../runtime/config/utils.js";
import {
  readRuntimeSetupCredential,
  assertRuntimeSetupCredentialFile,
  persistRuntimeSetupCredentials,
} from "./runtime-setup-credentials.js";
import {
  ModelSetupError,
  type ModelSetupInput,
  type NewModelProvider,
} from "./model-setup-input.js";
import type { ModelSetupOptions } from "./model-setup-catalog.js";

export function buildNewModelProvider(selection: NewModelProvider) {
  const config = buildProviderConfig(selection.type, selection.baseUrl);
  const needsIsolatedCredentialBinding = selection.type === "openai";
  if (needsIsolatedCredentialBinding)
    config.apiKeyEnv = isolatedProviderCredentialName(selection.id);
  return { id: selection.id, config };
}

export function planModelProvider(
  providers: Record<string, unknown>,
  input: ModelSetupInput,
) {
  if (input.providerId !== undefined) {
    const provider = Object.hasOwn(providers, input.providerId)
      ? providers[input.providerId]
      : undefined;
    if (!isRecord(provider))
      throw new ModelSetupError(
        "model_provider_not_found",
        "The selected provider no longer exists. Refresh and choose a provider.",
        404,
      );
    return { id: input.providerId, config: provider };
  }
  const selection = input.newProvider;
  if (Object.hasOwn(providers, selection.id))
    throw new ModelSetupError(
      "model_provider_exists",
      "That provider ID already exists. Choose its saved connection or use another ID.",
      409,
    );
  const provider = buildNewModelProvider(selection);
  const apiKeyEnv = provider.config.apiKeyEnv;
  const hasNewProviderCredentialCollision =
    typeof apiKeyEnv === "string" &&
    hasProviderCredentialBinding(providers, apiKeyEnv);
  if (hasNewProviderCredentialCollision)
    throw new ModelSetupError(
      "model_credential_conflict",
      "The new provider's credential name is already in use. Choose another provider ID.",
      409,
    );
  return provider;
}

export async function prepareModelCredential(
  options: ModelSetupOptions,
  provider: Record<string, unknown>,
  apiKey?: string,
) {
  const requiresApiKey = provider.type === "openai";
  if (!requiresApiKey) {
    if (apiKey)
      throw new ModelSetupError(
        "invalid_model_credential",
        "Only an OpenAI connection accepts an API key here.",
      );
    return undefined;
  }
  const apiKeyEnv =
    typeof provider.apiKeyEnv === "string"
      ? provider.apiKeyEnv
      : "OPENAI_API_KEY";
  await assertRuntimeSetupCredentialFile(options.rootDir);
  const savedKey = readRuntimeSetupCredential(options.rootDir, apiKeyEnv);
  if (savedKey && apiKey && savedKey !== apiKey)
    throw new ModelSetupError(
      "credential_already_configured",
      "That provider already has a saved API key. Its credential was preserved.",
      409,
    );
  if (!savedKey && !apiKey)
    throw new ModelSetupError(
      "model_credential_required",
      "Enter an API key for this OpenAI connection.",
    );
  return { apiKeyEnv, ...(savedKey ? {} : { apiKey }) };
}

export async function saveModelCredential(
  options: ModelSetupOptions & { configPath: string },
  credential: Awaited<ReturnType<typeof prepareModelCredential>>,
): Promise<boolean> {
  if (!credential) return false;
  try {
    await persistRuntimeSetupCredentials({
      ...options,
      ...credential,
      preserveExistingCredential: true,
    });
  } catch (error) {
    if (error instanceof RuntimeSetupError)
      throw new ModelSetupError(error.code, error.message, error.statusCode);
    throw error;
  }
  return true;
}
