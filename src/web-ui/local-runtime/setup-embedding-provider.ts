import { buildProviderConfig } from "../../../scripts/runtime-setup-files.js";
import { createFileLongTermMemoryOnboardingConfigRepository } from "../../runtime/adapters/long-term-memory/onboarding-config-repository.js";
import { isRecord } from "../../runtime/config/utils.js";
import { validateRuntimeConfigFile } from "../../runtime/config/validation.js";
import {
  assertRuntimeSetupCredentialFile,
  hasRuntimeSetupCredential,
  readRuntimeSetupCredential,
  persistRuntimeSetupCredentials,
} from "./runtime-setup-credentials.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import type { SetupEmbeddingInput } from "./setup-embedding-input.js";
import {
  hasProviderCredentialBinding,
  isolatedProviderCredentialName,
} from "./provider-credential-identity.js";

export type SavedEmbeddingProvider = Readonly<{ id: string; type: string }>;

function readProviderMap(models: unknown): Record<string, unknown> {
  if (!isRecord(models)) return {};
  return isRecord(models.providers) ? models.providers : {};
}

function hasRequestedEmbeddingAdapter(
  provider: unknown,
  adapter: string,
): boolean {
  if (!isRecord(provider)) return false;
  return provider.type === adapter;
}

function resolveSetupEmbeddingProviderId(
  providers: Record<string, unknown>,
  input: SetupEmbeddingInput,
): string {
  if (input.providerId) return input.providerId;
  const adapter = input.provider!;
  if (!Object.hasOwn(providers, adapter)) return adapter;
  if (hasRequestedEmbeddingAdapter(providers[adapter], adapter)) return adapter;
  let suffix = 2;
  while (Object.hasOwn(providers, `${adapter}-${suffix}`)) suffix += 1;
  return `${adapter}-${suffix}`;
}

function needsIsolatedEmbeddingCredential(
  existing: unknown,
  input: SetupEmbeddingInput,
  providerId: string,
): boolean {
  if (isRecord(existing)) return false;
  if (input.provider !== "openai") return false;
  return providerId !== input.provider;
}

function resolveIsolatedEmbeddingCredentialName(
  providers: Record<string, unknown>,
  providerId: string,
): string {
  const apiKeyEnv = isolatedProviderCredentialName(providerId);
  if (hasProviderCredentialBinding(providers, apiKeyEnv))
    throw new RuntimeSetupError(
      "embedding_credential_conflict",
      "The new connection's credential name is already used by another provider. Its settings were preserved.",
      409,
    );
  return apiKeyEnv;
}

function embeddingCredentialToSave(
  rootDir: string,
  apiKeyEnv: string,
  input: SetupEmbeddingInput,
  isolated: boolean,
): string | undefined {
  if (input.apiKey) return input.apiKey;
  if (!isolated) return undefined;
  if (readRuntimeSetupCredential(rootDir, apiKeyEnv)) return undefined;
  return readRuntimeSetupCredential(rootDir) || undefined;
}

function requirePreservedProviderSettings(
  provider: Record<string, unknown>,
  input: SetupEmbeddingInput,
): void {
  if (input.provider && provider.type !== input.provider) {
    throw new RuntimeSetupError(
      "embedding_provider_conflict",
      "That provider ID already uses another adapter. Its settings were preserved.",
      409,
    );
  }
  if (input.baseUrl && input.baseUrl !== provider.baseUrl) {
    throw new RuntimeSetupError(
      "embedding_provider_conflict",
      "That provider already uses another address. Choose its saved connection or edit it in Settings.",
      409,
    );
  }
  if (input.apiKey && provider.type !== "openai") {
    throw new RuntimeSetupError(
      "invalid_embedding_credential",
      "Only an OpenAI connection accepts an API key here.",
    );
  }
}

/** Adds only the requested provider; chat profiles and existing provider settings stay intact. */
export async function prepareSetupEmbeddingProvider(
  options: {
    rootDir: string;
    configPath?: string;
  },
  input: SetupEmbeddingInput,
): Promise<{ providerId: string; savedProvider: SavedEmbeddingProvider }> {
  const repository =
    createFileLongTermMemoryOnboardingConfigRepository(options);
  const snapshot = await repository.read();
  const providers = readProviderMap(snapshot.config.models);
  const providerId = resolveSetupEmbeddingProviderId(providers, input);
  const existing = providers[providerId];
  if (input.providerId && !isRecord(existing)) {
    throw new RuntimeSetupError(
      "embedding_provider_not_configured",
      "Choose a configured provider or add an OpenAI or Ollama connection.",
      404,
    );
  }
  const provider = isRecord(existing)
    ? existing
    : buildProviderConfig(input.provider!, input.baseUrl);
  const isolatedCredential = needsIsolatedEmbeddingCredential(
    existing,
    input,
    providerId,
  );
  if (isolatedCredential)
    provider.apiKeyEnv = resolveIsolatedEmbeddingCredentialName(
      providers,
      providerId,
    );
  requirePreservedProviderSettings(provider, input);
  const models = isRecord(snapshot.config.models) ? snapshot.config.models : {};
  const candidate = {
    ...snapshot.config,
    models: { ...models, providers: { ...providers, [providerId]: provider } },
  };
  validateRuntimeConfigFile(candidate, snapshot.path);
  const apiKeyEnv =
    typeof provider.apiKeyEnv === "string"
      ? provider.apiKeyEnv
      : "OPENAI_API_KEY";
  if (provider.type === "openai") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
      throw new RuntimeSetupError(
        "invalid_embedding_credential_environment",
        "The configured credential environment name is invalid. Its settings were preserved.",
      );
    }
    await assertRuntimeSetupCredentialFile(options.rootDir);
    const apiKey = embeddingCredentialToSave(
      options.rootDir,
      apiKeyEnv,
      input,
      isolatedCredential,
    );
    if (
      !apiKey &&
      !(await hasRuntimeSetupCredential(options.rootDir, apiKeyEnv))
    ) {
      throw new RuntimeSetupError(
        "embedding_credential_required",
        "Enter an OpenAI API key for the embedding connection.",
      );
    }
    await persistRuntimeSetupCredentials({
      rootDir: options.rootDir,
      configPath: snapshot.path,
      apiKey,
      apiKeyEnv,
      preserveExistingCredential: true,
    });
  }
  if (!isRecord(existing)) await repository.write(candidate, snapshot.config);
  return {
    providerId,
    savedProvider: { id: providerId, type: provider.type as string },
  };
}
