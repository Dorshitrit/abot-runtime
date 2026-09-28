import { isDeepStrictEqual } from "node:util";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { mergeRuntimeModelAddition } from "../../../scripts/runtime-model-addition.js";
import {
  ConfigFileConflictError,
  canonicalConfigFilePath,
  readConfigFileSnapshot,
  withConfigFileTransaction,
  type ConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import { validateRuntimeConfigFile } from "../../runtime/config/validation.js";
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
import { removeRuntimeModelDeclaration } from "./model-removal.js";
import {
  isDiscoveredModelSetupProfileAtTarget,
  withModelSetupProfile,
} from "./model-setup-profile-file.js";

function isModelConfigLocationInsideWorkspace(
  rootDir: string,
  path: string,
): boolean {
  const location = relative(rootDir, path);
  return !location.startsWith("..") && !isAbsolute(location);
}

function requireModelConfigLocationInsideWorkspace(
  rootDir: string,
  path: string,
): void {
  if (isModelConfigLocationInsideWorkspace(rootDir, path)) return;
  throw new ModelSetupError(
    "model_config_outside_workspace",
    "The selected configuration must be inside the workspace.",
    409,
  );
}

async function hasCommittedModelAddition(
  transaction: ConfigFileTransaction,
  candidate: Record<string, unknown>,
): Promise<boolean> {
  try {
    const current = await readConfigFileSnapshot(transaction.path);
    return isDeepStrictEqual(current.config, candidate);
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
    const rootDir = await realpath(this.options.rootDir);
    // Rebase only the workspace prefix. Resolving inner parent links would
    // change the Runtime's lexical resolution of references such as ../models.
    const configPath = isModelConfigLocationInsideWorkspace(
      this.options.rootDir,
      source.path,
    )
      ? resolve(rootDir, relative(this.options.rootDir, source.path))
      : source.path;
    const canonicalConfigPath = await realpath(source.path);
    requireModelConfigLocationInsideWorkspace(rootDir, configPath);
    requireModelConfigLocationInsideWorkspace(rootDir, canonicalConfigPath);
    requireModelConfigLocationInsideWorkspace(
      rootDir,
      await realpath(dirname(source.path)),
    );
    return { rootDir, configPath, canonicalConfigPath };
  }

  async remove(body: Record<string, unknown>) {
    const options = await this.canonicalOptions();
    return withConfigFileTransaction(
      options.canonicalConfigPath,
      (transaction) =>
        removeRuntimeModelDeclaration(options, transaction, body),
    );
  }

  async add(body: Record<string, unknown>) {
    const input = parseModelSetupInput(body);
    const options = await this.canonicalOptions();
    return withConfigFileTransaction(
      options.canonicalConfigPath,
      (transaction) => this.save(options, input, transaction),
    );
  }

  private async save(
    options: ModelSetupOptions & { configPath: string },
    input: ModelSetupInput,
    transaction: ConfigFileTransaction,
  ) {
    const selectedPath = await canonicalConfigFilePath(options.configPath);
    const hasLockedSelectedConfig =
      transaction.snapshot.exists && transaction.path === selectedPath;
    if (!hasLockedSelectedConfig)
      throw new ModelSetupError(
        "config_changed",
        "The selected configuration changed while being opened. Reload Configuration before retrying.",
        409,
      );
    const source = transaction.snapshot.config;
    validateRuntimeConfigFile(source, transaction.path);
    const models = modelConfigMap(source.models);
    const dashboard = await getConfigDashboardSnapshot(
      options,
      transaction.snapshot,
    );
    const savedProfiles = modelConfigMap(models.profiles);
    if (Object.hasOwn(savedProfiles, input.profileId))
      return recoverCommittedModelAddition(
        options,
        models,
        input,
        transaction.snapshot.revision,
      );
    const discovered = dashboard.files.models.find(
      (entry) => entry.id === input.profileId,
    );
    if (
      discovered &&
      !(await isDiscoveredModelSetupProfileAtTarget(
        options,
        input.profileId,
        resolve(options.rootDir, discovered.path),
      ))
    )
      throw new ModelSetupError(
        "model_profile_exists",
        "Another model file already uses this profile ID. Choose another ID.",
        409,
      );
    const provider = planModelProvider(modelConfigMap(models.providers), input);
    const profile = await buildModelSetupProfile(provider, input);
    const addition = {
      profileId: input.profileId,
      providerId: provider.id,
      provider: provider.config,
      profile,
    };
    await validateModelAddition(
      mergeRuntimeModelAddition(source, addition).config,
      options,
    );
    const credential = await prepareModelCredential(
      options,
      provider.config,
      input.apiKey,
    );
    return withModelSetupProfile(
      options,
      transaction,
      input.profileId,
      profile,
      async (declaration, assertProfileUnchanged) => {
        const candidate = mergeRuntimeModelAddition(source, {
          ...addition,
          profile: declaration,
        }).config;
        await validateModelAddition(candidate, options);
        await assertProfileUnchanged();
        await this.commit(
          options,
          candidate,
          transaction,
          credential,
          assertProfileUnchanged,
        );
        return modelSetupResult(provider, input);
      },
    );
  }

  private async commit(
    options: ModelSetupOptions & { configPath: string },
    candidate: Record<string, unknown>,
    transaction: ConfigFileTransaction,
    credential: Awaited<ReturnType<typeof prepareModelCredential>>,
    assertProfileUnchanged: () => Promise<void>,
  ) {
    let credentialSaved = false;
    let configSaveAttempted = false;
    try {
      credentialSaved = await saveModelCredential(options, credential);
      await assertProfileUnchanged();
      configSaveAttempted = true;
      await saveConfigDashboardFile({
        ...options,
        kind: "runtime",
        config: candidate,
        transaction,
      });
    } catch (error) {
      if (error instanceof ModelSetupError) {
        if (!credentialSaved || error.credentialSaved) throw error;
        throw new ModelSetupError(
          error.code,
          error.message,
          error.statusCode,
          true,
        );
      }
      if (error instanceof ConfigFileConflictError)
        throw new ModelSetupError(
          "config_changed",
          error.message,
          409,
          credentialSaved,
        );
      const modelCommitted =
        configSaveAttempted &&
        (await hasCommittedModelAddition(transaction, candidate));
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
  }
}
