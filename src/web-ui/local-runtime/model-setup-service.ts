import { isDeepStrictEqual } from "node:util";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { mergeRuntimeModelAddition } from "../../../scripts/runtime-model-addition.js";
import {
  ConfigFileConflictError,
  withConfigFileTransaction,
  type ConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../config-dashboard-backend.js";
import {
  getModelSetupCatalog,
  modelConfigMap,
  readModelSetupSource,
  type ModelSetupOptions,
} from "./model-setup-catalog.js";
import {
  ModelSetupError,
  parseModelSetupInput,
  type ModelSetupInput,
} from "./model-setup-input.js";
import {
  planModelProvider,
  prepareModelCredential,
  saveModelCredential,
} from "./model-setup-provider.js";
import { validateModelAddition } from "./model-setup-validation.js";
import {
  buildModelSetupProfile,
  modelSetupResult,
} from "./model-setup-identity.js";
import { recoverCommittedModelAddition } from "./model-setup-retry.js";

function hasCommittedModelAddition(
  options: ModelSetupOptions,
  candidate: Record<string, unknown>,
): boolean {
  try {
    return isDeepStrictEqual(readModelSetupSource(options).config, candidate);
  } catch {
    return false;
  }
}

export class ModelSetupService {
  constructor(
    private readonly options: {
      rootDir: string;
      getConfigPath: () => string | undefined;
    },
  ) {}

  private sourceOptions(): ModelSetupOptions {
    return {
      rootDir: this.options.rootDir,
      configPath: this.options.getConfigPath(),
    };
  }

  async catalog() {
    return getModelSetupCatalog(await this.canonicalOptions());
  }

  private async canonicalOptions() {
    const source = readModelSetupSource(this.sourceOptions());
    const options = {
      rootDir: await realpath(this.options.rootDir),
      configPath: await realpath(source.path),
    };
    const target = relative(options.rootDir, options.configPath);
    if (target.startsWith("..") || isAbsolute(target))
      throw new ModelSetupError(
        "model_config_outside_workspace",
        "The selected configuration must be inside the workspace.",
        409,
      );
    return options;
  }

  async add(body: Record<string, unknown>) {
    const input = parseModelSetupInput(body);
    const options = await this.canonicalOptions();
    return withConfigFileTransaction(options.configPath, (transaction) =>
      this.save(options, input, transaction),
    );
  }

  private async save(
    options: ModelSetupOptions & { configPath: string },
    input: ModelSetupInput,
    transaction: ConfigFileTransaction,
  ) {
    const source = readModelSetupSource(options);
    const models = modelConfigMap(source.config.models);
    const dashboard = await getConfigDashboardSnapshot(options);
    const profileExists = dashboard.files.models.some(
      (profile) => profile.id === input.profileId,
    );
    if (profileExists)
      return recoverCommittedModelAddition(
        options,
        models,
        input,
        transaction.snapshot.revision,
      );
    const provider = planModelProvider(modelConfigMap(models.providers), input);
    const profile = await buildModelSetupProfile(provider, input);
    const candidate = mergeRuntimeModelAddition(source.config, {
      profileId: input.profileId,
      providerId: provider.id,
      provider: provider.config,
      profile,
    }).config;
    await validateModelAddition(candidate, options);
    const credential = await prepareModelCredential(
      options,
      provider.config,
      input.apiKey,
    );
    let credentialSaved = false;
    let configSaveAttempted = false;
    try {
      credentialSaved = await saveModelCredential(options, credential);
      configSaveAttempted = true;
      await saveConfigDashboardFile({
        ...options,
        kind: "runtime",
        config: candidate,
        transaction,
      });
    } catch (error) {
      if (error instanceof ModelSetupError) throw error;
      if (error instanceof ConfigFileConflictError)
        throw new ModelSetupError(
          "config_changed",
          error.message,
          409,
          credentialSaved,
        );
      const modelCommitted =
        configSaveAttempted && hasCommittedModelAddition(options, candidate);
      if (!modelCommitted)
        throw new ModelSetupError(
          "model_save_failed",
          credentialSaved
            ? "The credential is saved, but the model save could not be confirmed. Refresh Configuration, then retry without re-entering the key if the model is missing."
            : "The model save could not be confirmed. Refresh Configuration before trying again.",
          500,
          credentialSaved,
        );
    }
    return modelSetupResult(provider, input);
  }
}
