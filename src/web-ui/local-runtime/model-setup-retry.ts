import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshot } from "../../runtime/adapters/config-file-transaction.js";
import { isRecord } from "../../runtime/config/utils.js";
import {
  modelConfigMap,
  type ModelSetupOptions,
} from "./model-setup-catalog.js";
import {
  buildModelSetupProfile,
  modelSetupResult,
} from "./model-setup-identity.js";
import { ModelSetupError, type ModelSetupInput } from "./model-setup-input.js";
import { readSavedModelSetupProfile } from "./model-setup-profile-file.js";
import {
  buildNewModelProvider,
  planModelProvider,
  prepareModelCredential,
} from "./model-setup-provider.js";

function rejectModelProfileCollision(): never {
  throw new ModelSetupError(
    "model_profile_exists",
    "That model profile ID already exists with different settings. Choose another ID.",
    409,
  );
}

function committedRetryProvider(
  providers: Record<string, unknown>,
  input: ModelSetupInput,
) {
  if (input.providerId !== undefined)
    return planModelProvider(providers, input);
  return buildNewModelProvider(input.newProvider);
}

async function requireUnchangedRetryConfiguration(
  options: ModelSetupOptions & { configPath: string },
  expectedRevision: string,
) {
  const current = await readConfigFileSnapshot(options.configPath);
  if (current.revision === expectedRevision) return;
  throw new ModelSetupError(
    "config_changed",
    "Configuration changed while the saved model was being checked. Refresh before retrying.",
    409,
  );
}

/** A repeated POST may acknowledge only the exact addition already committed. */
export async function recoverCommittedModelAddition(
  options: ModelSetupOptions & { configPath: string },
  models: Record<string, unknown>,
  input: ModelSetupInput,
  expectedRevision: string,
) {
  const profiles = modelConfigMap(models.profiles);
  const declaration = profiles[input.profileId];
  if (!isRecord(declaration)) rejectModelProfileCollision();
  const saved = await readSavedModelSetupProfile(options, declaration);
  const providers = modelConfigMap(models.providers);
  const providerId = input.providerId ?? input.newProvider.id;
  const hasSavedProviderConnection = isRecord(providers[providerId]);
  if (!hasSavedProviderConnection) rejectModelProfileCollision();
  const provider = committedRetryProvider(providers, input);
  const savedProviderMatchesRequest = isDeepStrictEqual(
    providers[provider.id],
    provider.config,
  );
  if (!savedProviderMatchesRequest) rejectModelProfileCollision();
  const expectedProfile = await buildModelSetupProfile(provider, input);
  const savedProfileMatchesRequest = isDeepStrictEqual(
    saved.profile,
    expectedProfile,
  );
  if (!savedProfileMatchesRequest) rejectModelProfileCollision();
  const credential = await prepareModelCredential(
    options,
    provider.config,
    input.apiKey,
  );
  if (credential?.apiKey)
    throw new ModelSetupError(
      "model_credential_required",
      "The saved model's credential is missing. Restore its connection in Models before retrying.",
      409,
    );
  await requireUnchangedRetryConfiguration(options, expectedRevision);
  await saved.assertUnchanged();
  return modelSetupResult(provider, input);
}
