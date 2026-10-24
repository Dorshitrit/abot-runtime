import { buildProviderConfig } from "../../../scripts/runtime-setup-files.js";
import { isRecord } from "../../runtime/config/utils.js";
import {
  hasProviderCredentialBinding,
  isolatedProviderCredentialName,
} from "./provider-credential-identity.js";
import { requiresProviderCredential } from "./runtime-setup-auth.js";
import {
  assertRuntimeSetupCredentialFile,
  hasRuntimeSetupCredential,
  commitRuntimeSetupCredentials,
} from "./runtime-setup-credentials.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import type { SetupEmbeddingInput } from "./setup-embedding-input.js";

/** A new embedding server has its own explicit, replayable connection identity. */
export function planNewLlamaEmbeddingProvider(
  providers: Record<string, unknown>,
  input: SetupEmbeddingInput,
) {
  const providerId = input.newProviderId!;
  const useApiKey = input.useApiKey === true || Boolean(input.apiKey);
  const apiKeyEnv = useApiKey
    ? isolatedProviderCredentialName(providerId)
    : undefined;
  const provider = buildProviderConfig("llamacpp", input.baseUrl, apiKeyEnv);
  const existing = providers[providerId];
  if (existing !== undefined) {
    requireMatchingLlamaEmbeddingConnection(existing, provider);
    return { providerId, provider: existing as Record<string, unknown> };
  }
  if (apiKeyEnv && hasProviderCredentialBinding(providers, apiKeyEnv))
    throw new RuntimeSetupError(
      "embedding_credential_conflict",
      "This connection's credential name is already used by another provider. Choose another connection ID.",
      409,
    );
  return { providerId, provider };
}

function requireMatchingLlamaEmbeddingConnection(
  existing: unknown,
  requested: Record<string, unknown>,
): void {
  if (
    isRecord(existing) &&
    existing.type === requested.type &&
    existing.baseUrl === requested.baseUrl &&
    existing.apiKeyEnv === requested.apiKeyEnv
  )
    return;
  throw new RuntimeSetupError(
    "embedding_provider_conflict",
    "That connection ID already has different settings. Choose its saved connection or use another ID. Existing settings were preserved.",
    409,
  );
}

/** A saved llama.cpp connection keeps its existing optional authentication binding. */
export async function commitLlamaEmbeddingProvider(
  options: { rootDir: string; configPath: string },
  provider: Record<string, unknown>,
  input: SetupEmbeddingInput,
  commit: () => Promise<unknown>,
) {
  if (!requiresProviderCredential(provider)) {
    if (input.apiKey)
      throw new RuntimeSetupError(
        "invalid_embedding_credential",
        "This saved connection has no API key binding. Add a separate connection to use authentication.",
      );
    await commit();
    return;
  }
  const apiKeyEnv = provider.apiKeyEnv as string;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv))
    throw new RuntimeSetupError(
      "invalid_embedding_credential_environment",
      "The configured credential environment name is invalid. Its settings were preserved.",
    );
  await assertRuntimeSetupCredentialFile(options.rootDir);
  if (
    !input.apiKey &&
    !(await hasRuntimeSetupCredential(options.rootDir, apiKeyEnv))
  )
    throw new RuntimeSetupError(
      "embedding_credential_required",
      "Enter the API key for this llama.cpp connection.",
    );
  await commitRuntimeSetupCredentials(
    {
      ...options,
      apiKeyEnv,
      apiKey: input.apiKey,
      preserveExistingCredential: true,
    },
    commit,
  );
}
