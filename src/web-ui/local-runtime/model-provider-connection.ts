import {
  canonicalConfigFilePath,
  ConfigFileConflictError,
  withConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import { buildModelConfig } from "../../runtime/config/builders.js";
import { isRecord } from "../../runtime/config/utils.js";
import { RuntimeConfigValidationError } from "../../runtime/config/validation.js";
import { modelConfigMap } from "./model-setup-catalog.js";
import { ModelSetupError } from "./model-setup-input.js";
import { validateModelConfigurationChange } from "./model-setup-validation.js";
import { editSavedModelProvider } from "./model-provider-edit.js";

type ConnectionOperation = "update" | "remove";
type ProviderTransactionOptions = {
  rootDir: string;
  configPath: string;
  canonicalConfigPath: string;
};

function parseConnectionRequest(
  body: Record<string, unknown>,
  operation: ConnectionOperation,
) {
  const { providerId, expectedRevision, ...fields } = body;
  if (typeof providerId !== "string" || !providerId.trim())
    throw new ModelSetupError(
      "invalid_model_provider",
      "Choose a saved provider connection.",
    );
  if (typeof expectedRevision !== "string" || !expectedRevision.trim())
    throw new ModelSetupError(
      "config_revision_required",
      "Reload Configuration before changing this connection.",
      428,
    );
  if (operation === "remove" && Object.keys(fields).length > 0)
    throw new ModelSetupError(
      "invalid_model_provider_removal",
      "The provider removal contains unsupported fields.",
    );
  return { providerId, expectedRevision, fields };
}

function requireUnusedProvider(
  config: Record<string, unknown>,
  path: string,
  providerId: string,
) {
  const policy = buildModelConfig(config, { mainConfigPath: path });
  const usesProvider = ([, profile]: [string, { provider?: string }]) =>
    profile.provider === providerId;
  const chat = Object.entries(policy?.profiles ?? {}).find(usesProvider);
  if (chat)
    throw new ModelSetupError(
      "model_provider_in_use",
      `Model profile "${chat[0]}" uses this provider connection.`,
      409,
    );
  const embedding = Object.entries(policy?.embeddingProfiles ?? {}).find(
    usesProvider,
  );
  if (embedding)
    throw new ModelSetupError(
      "model_provider_in_use",
      `Embedding profile "${embedding[0]}" uses this provider connection.`,
      409,
    );
}

async function requireSelectedProviderConfig(
  selectedPath: string,
  transactionPath: string,
) {
  if ((await canonicalConfigFilePath(selectedPath)) !== transactionPath)
    throw new ConfigFileConflictError();
}

/** The runtime config transaction also serializes cooperating model profile edits. */
export async function changeRuntimeModelProvider(
  options: ProviderTransactionOptions,
  body: Record<string, unknown>,
  operation: ConnectionOperation,
) {
  const input = parseConnectionRequest(body, operation);
  const { providerId, expectedRevision } = input;
  try {
    return await withConfigFileTransaction(
      options.canonicalConfigPath,
      async (transaction) => {
        await requireSelectedProviderConfig(
          options.configPath,
          transaction.path,
        );
        if (transaction.snapshot.revision !== expectedRevision)
          throw new ConfigFileConflictError();
        const source = transaction.snapshot.config;
        const models = modelConfigMap(source.models);
        const registered = modelConfigMap(models.providers);
        const provider = Object.hasOwn(registered, providerId)
          ? registered[providerId]
          : undefined;
        if (!isRecord(provider))
          throw new ModelSetupError(
            "model_provider_not_found",
            "The saved provider connection no longer exists. Reload Configuration.",
            404,
          );
        const providers =
          operation === "update"
            ? {
                ...registered,
                [providerId]: await editSavedModelProvider(
                  provider,
                  input.fields,
                ),
              }
            : withoutSavedProvider(
                registered,
                providerId,
                source,
                options.configPath,
              );
        const candidate = { ...source, models: { ...models, providers } };
        await validateModelConfigurationChange(candidate, options);
        await requireSelectedProviderConfig(
          options.configPath,
          transaction.path,
        );
        await transaction.write(candidate, { expectedRevision });
        return { providerId, restartRequired: true };
      },
    );
  } catch (error) {
    if (error instanceof ConfigFileConflictError)
      throw new ModelSetupError("config_changed", error.message, 409);
    if (error instanceof RuntimeConfigValidationError)
      throw new ModelSetupError(
        "model_provider_invalid_config",
        "This change would leave an invalid Runtime configuration. Check the registered profiles and their settings.",
        409,
      );
    throw error;
  }
}

function withoutSavedProvider(
  registered: Record<string, unknown>,
  providerId: string,
  source: Record<string, unknown>,
  configPath: string,
) {
  if (Object.keys(registered).length < 2)
    throw new ModelSetupError(
      "model_provider_required",
      "Keep at least one provider connection configured.",
      409,
    );
  requireUnusedProvider(source, configPath, providerId);
  const remaining = { ...registered };
  delete remaining[providerId];
  return remaining;
}
