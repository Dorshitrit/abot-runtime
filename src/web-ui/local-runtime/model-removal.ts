import {
  ConfigFileConflictError,
  canonicalConfigFilePath,
  type ConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import { isRecord } from "../../runtime/config/utils.js";
import { RuntimeConfigValidationError } from "../../runtime/config/validation.js";
import { ModelSetupError } from "./model-setup-input.js";
import { validateModelConfigurationChange } from "./model-setup-validation.js";

export type ModelRemovalInput = Readonly<{
  profileId: string;
  expectedRevision: string;
}>;

function hasUnsupportedRemovalFields(body: Record<string, unknown>): boolean {
  return Object.keys(body).some(
    (key) => !["profileId", "expectedRevision"].includes(key),
  );
}

function hasRemovalProfileId(
  body: Record<string, unknown>,
): body is Record<string, unknown> & { profileId: string } {
  if (typeof body.profileId !== "string") return false;
  return body.profileId.trim().length > 0;
}

function hasRemovalRevision(
  body: Record<string, unknown>,
): body is Record<string, unknown> & { expectedRevision: string } {
  if (typeof body.expectedRevision !== "string") return false;
  return body.expectedRevision.trim().length > 0;
}

function parseModelRemovalInput(
  body: Record<string, unknown>,
): ModelRemovalInput {
  if (hasUnsupportedRemovalFields(body))
    throw new ModelSetupError(
      "invalid_model_input",
      "The model removal contains unsupported fields.",
    );
  if (!hasRemovalProfileId(body))
    throw new ModelSetupError(
      "invalid_model_input",
      "Choose a registered model to remove.",
    );
  if (!hasRemovalRevision(body))
    throw new ModelSetupError(
      "config_revision_required",
      "Reload Configuration before removing this model.",
      428,
    );
  return { profileId: body.profileId, expectedRevision: body.expectedRevision };
}

async function validateRemovalCandidate(
  candidate: Record<string, unknown>,
  options: { rootDir: string; configPath: string },
): Promise<void> {
  try {
    await validateModelConfigurationChange(candidate, options);
  } catch (error) {
    if (!(error instanceof RuntimeConfigValidationError)) throw error;
    throw new ModelSetupError(
      "model_removal_invalid_config",
      "Removing this model would leave an invalid configuration. " +
        error.issues.join("; "),
      409,
    );
  }
}

async function hasSelectedRemovalTarget(
  configPath: string,
  transaction: ConfigFileTransaction,
): Promise<boolean> {
  return transaction.path === (await canonicalConfigFilePath(configPath));
}

/** Remove the declaration only; referenced files and provider credentials remain intact. */
export async function removeRuntimeModelDeclaration(
  options: { rootDir: string; configPath: string },
  transaction: ConfigFileTransaction,
  body: Record<string, unknown>,
) {
  const input = parseModelRemovalInput(body);
  if (!(await hasSelectedRemovalTarget(options.configPath, transaction)))
    throw new Error(
      "Model removal requires the canonical Runtime transaction.",
    );
  if (transaction.snapshot.revision !== input.expectedRevision)
    throw new ModelSetupError(
      "config_changed",
      "Configuration changed since it was loaded. Reload Configuration before removing this model.",
      409,
    );
  const config = transaction.snapshot.config;
  const models = isRecord(config.models) ? config.models : {};
  const profiles = isRecord(models.profiles) ? models.profiles : {};
  if (!Object.hasOwn(profiles, input.profileId))
    throw new ModelSetupError(
      "model_profile_not_registered",
      "This model is no longer registered. Reload Configuration.",
      409,
    );
  const remainingProfiles = { ...profiles };
  delete remainingProfiles[input.profileId];
  const candidate = {
    ...config,
    models: { ...models, profiles: remainingProfiles },
  };
  await validateRemovalCandidate(candidate, options);
  try {
    if (!(await hasSelectedRemovalTarget(options.configPath, transaction)))
      throw new ConfigFileConflictError();
    await transaction.write(candidate, {
      expectedRevision: input.expectedRevision,
    });
  } catch (error) {
    if (!(error instanceof ConfigFileConflictError)) throw error;
    throw new ModelSetupError("config_changed", error.message, 409);
  }
  return { profileId: input.profileId, restartRequired: true };
}
