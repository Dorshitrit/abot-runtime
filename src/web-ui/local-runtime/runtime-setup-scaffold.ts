import {
  createRuntimeSetupDraft,
  type RuntimeSetupDraft,
} from "./runtime-setup-draft.js";
import {
  withConfigFileTransaction,
  readConfigFileSnapshot,
  type ConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import { validateRuntimeSetupPlan } from "./runtime-setup-validation.js";
import { planRuntimeSetupModelFile } from "./runtime-setup-model-file.js";
import { recoverSetupProviderOwnership } from "./runtime-setup-provider-ownership-recovery.js";
import { retainSetupConnectionProviders } from "./runtime-setup-provider-retention.js";
import { shouldInvalidateSetupEmbedding } from "./runtime-setup-embedding-invalidation.js";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildModelConfig,
  buildProviderConfig,
  DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES,
  isRecord,
  readJsonObject,
  resolveRuntimePackageRoot,
  writeJsonObject,
} from "../../../scripts/runtime-setup-files.js";
import {
  inspectRuntimeConfigFileWithMeta,
  type InspectedRuntimeConfigFile,
} from "../../runtime/config/loader.js";
import { parseRequestRunnerConfig } from "../../runtime/config/runner/versioned-config.js";
import {
  RuntimeSetupError,
  type RuntimeSetupInput,
} from "./runtime-setup-input.js";

type PlannedSetupFile = { path: string; value: Record<string, unknown> };
type CreatedSetupFile = { path: string; expectedContent: string };

async function removeUnchangedSetupFile(file: CreatedSetupFile): Promise<void> {
  try {
    const info = await lstat(file.path);
    if (!info.isFile() || info.isSymbolicLink()) return;
    if ((await readFile(file.path, "utf8")) !== file.expectedContent) return;
    await rm(file.path, { force: true });
  } catch {
    // A changed or inaccessible file belongs to its current owner and is retained.
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function configMap(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requireEmptyModelProfiles(source: InspectedRuntimeConfigFile): void {
  const models = configMap(source.config.models);
  const profiles = configMap(models.profiles);
  if (Object.keys(profiles).length > 0) {
    throw new RuntimeSetupError(
      "setup_configuration_exists",
      "Model profiles already exist. Use configuration settings to change them.",
      409,
    );
  }
}

function requireCompatibleProvider(
  existing: unknown,
  requested: Record<string, unknown>,
  owned: boolean,
): void {
  if (existing === undefined) return;
  if (owned) return;
  if (!isDeepStrictEqual(existing, requested)) {
    throw new RuntimeSetupError(
      "setup_provider_conflict",
      "This provider already has settings. Preserve or edit them in configuration settings.",
      409,
    );
  }
}

async function planRunnerFile(
  path: string,
  template: Record<string, unknown>,
): Promise<PlannedSetupFile[]> {
  if (!(await pathExists(path))) return [{ path, value: template }];
  const runner = parseRequestRunnerConfig(await readJsonObject(path), path);
  if (runner.models.defaults.profileId !== "default") {
    throw new RuntimeSetupError(
      "setup_runner_conflict",
      "The existing request runner selects another model. Preserve or edit it in configuration settings.",
      409,
    );
  }
  return [];
}

function rebaseRunnerInstructions(
  runner: Record<string, unknown>,
  target: (file: string) => string,
): Record<string, unknown> {
  const steps = configMap(runner.steps);
  return {
    ...runner,
    steps: Object.fromEntries(
      Object.entries(steps).map(([id, value]) => {
        const step = configMap(value);
        if (!Array.isArray(step.instructionRefs)) return [id, value];
        const refs = step.instructionRefs.map((ref: string) =>
          target(ref.replace(/^\.\.\//u, "")),
        );
        return [id, { ...step, instructionRefs: refs }];
      }),
    ),
  };
}

async function restoreSetupScaffoldConfig(
  transaction: ConfigFileTransaction,
  source: InspectedRuntimeConfigFile,
  candidate: Record<string, unknown>,
): Promise<void> {
  if (source.exists) {
    await transaction.write(source.config, { expectedConfig: candidate });
    return;
  }
  const current = await readConfigFileSnapshot(transaction.path);
  if (current.revision !== transaction.snapshot.revision)
    throw new RuntimeSetupError(
      "setup_configuration_changed",
      "Configuration changed while setup was being saved.",
      409,
    );
  await rm(transaction.path, { force: true });
}

/** Uses the same package templates and provider/model builders as the CLI. */
export async function writeRuntimeSetupScaffold(params: {
  rootDir: string;
  configPath: string;
  source: InspectedRuntimeConfigFile;
  input: RuntimeSetupInput;
  recoveringDraft?: boolean;
  recoveryDraft?: RuntimeSetupDraft;
  credentialChanged?: boolean;
  commitWithCredentials?: (
    commit: () => Promise<RuntimeSetupDraft>,
  ) => Promise<RuntimeSetupDraft>;
}): Promise<{ draft: RuntimeSetupDraft; embeddingInvalidated: boolean }> {
  return withConfigFileTransaction(params.configPath, (transaction) =>
    saveRuntimeSetupScaffold(params, transaction),
  );
}

async function saveRuntimeSetupScaffold(
  params: {
    rootDir: string;
    configPath: string;
    source: InspectedRuntimeConfigFile;
    input: RuntimeSetupInput;
    recoveringDraft?: boolean;
    recoveryDraft?: RuntimeSetupDraft;
    credentialChanged?: boolean;
    commitWithCredentials?: (
      commit: () => Promise<RuntimeSetupDraft>,
    ) => Promise<RuntimeSetupDraft>;
  },
  transaction: ConfigFileTransaction,
): Promise<{ draft: RuntimeSetupDraft; embeddingInvalidated: boolean }> {
  requireEmptyModelProfiles(params.source);
  const templateRoot = resolveRuntimePackageRoot(import.meta.dirname);
  const [runtimeTemplate, modelTemplate, runnerTemplate] = await Promise.all([
    readJsonObject(join(templateRoot, "examples/runtime.config.example.json")),
    readJsonObject(join(templateRoot, "examples/models/default.config.json")),
    readJsonObject(
      join(templateRoot, "examples/request-runner.config.example.json"),
    ),
  ]);
  const configDirectory = dirname(params.configPath);
  const models = configMap(params.source.config.models);
  const providers = configMap(models.providers);
  const provider = buildProviderConfig(
    params.input.provider,
    params.input.baseUrl,
  );
  const ownedProviders = await recoverSetupProviderOwnership(
    params.source,
    params.recoveringDraft ? params.recoveryDraft : undefined,
    transaction.path,
  );
  const existingProvider = providers[params.input.provider];
  requireCompatibleProvider(
    existingProvider,
    provider,
    Object.hasOwn(ownedProviders, params.input.provider),
  );
  const retained = retainSetupConnectionProviders({
    providers,
    ownedProviders,
    embeddingProfiles: models.embeddingProfiles,
    providerId: params.input.provider,
    provider,
  });
  const embeddingInvalidated = shouldInvalidateSetupEmbedding({
    config: params.source.config,
    providerId: params.input.provider,
    provider,
    providerChanged: !isDeepStrictEqual(existingProvider, provider),
    credentialChanged: params.credentialChanged === true,
  });
  const memory = configMap(params.source.config.longTermMemory);
  const runnerSettings = configMap(params.source.config.requestRunner);
  const runnerRef =
    typeof runnerSettings.configRef === "string" &&
    runnerSettings.configRef.trim()
      ? runnerSettings.configRef
      : "./request-runner.config.json";
  const runnerPath = resolve(configDirectory, runnerRef);
  const modelFile = await planRuntimeSetupModelFile(
    params.configPath,
    params.recoveringDraft === true,
  );
  const runnerModels = configMap(runnerTemplate.models);
  runnerTemplate.models = {
    ...runnerModels,
    defaults: { ...configMap(runnerModels.defaults), profileId: "default" },
  };
  const modelConfig = buildModelConfig(
    modelTemplate,
    params.input.provider,
    params.input.model,
    params.input.contextWindowTokens,
  );
  const rebasedRunner = rebaseRunnerInstructions(runnerTemplate, (file) =>
    relative(dirname(runnerPath), join(params.rootDir, file)),
  );
  const runnerFiles = await planRunnerFile(runnerPath, rebasedRunner);
  const plannedFiles = [
    { path: modelFile.path, value: modelConfig },
    ...runnerFiles,
  ];
  const runtimeConfig = {
    ...runtimeTemplate,
    ...params.source.config,
    models: {
      ...models,
      providers: retained.providers,
      profiles: { default: { configRef: modelFile.configRef } },
    },
    requestRunner: { ...runnerSettings, configRef: runnerRef },
    ...(embeddingInvalidated
      ? { longTermMemory: { ...memory, enabled: false } }
      : {}),
  };
  const instructionSources = new Map<string, string>();
  for (const file of DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES) {
    const existing = join(params.rootDir, file);
    instructionSources.set(
      file,
      (await pathExists(existing)) ? existing : join(templateRoot, file),
    );
  }
  await validateRuntimeSetupPlan({
    rootDir: params.rootDir,
    config: runtimeConfig,
    modelConfig,
    runnerPath,
    ...(runnerFiles.length
      ? {
          runnerConfig: rebaseRunnerInstructions(runnerTemplate, (file) =>
            join(templateRoot, file),
          ),
        }
      : {}),
  });
  const current = inspectRuntimeConfigFileWithMeta(
    params.rootDir,
    params.source.path,
  );
  if (!isDeepStrictEqual(current, params.source)) {
    throw new RuntimeSetupError(
      "setup_configuration_changed",
      "Configuration changed while setup was being saved. Refresh and try again.",
      409,
    );
  }
  const created: CreatedSetupFile[] = [];
  let configWritten = false;
  try {
    for (const file of plannedFiles) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeJsonObject(file.path, file.value, { exclusive: true });
      created.push({
        path: file.path,
        expectedContent: JSON.stringify(file.value, null, 2) + "\n",
      });
    }
    for (const file of DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES) {
      const destination = join(params.rootDir, file);
      if (await pathExists(destination)) continue;
      await mkdir(dirname(destination), { recursive: true });
      const expectedContent = await readFile(join(templateRoot, file), "utf8");
      await copyFile(
        join(templateRoot, file),
        destination,
        constants.COPYFILE_EXCL,
      );
      created.push({ path: destination, expectedContent });
    }
    await mkdir(configDirectory, { recursive: true });
    const beforeCommit = inspectRuntimeConfigFileWithMeta(
      params.rootDir,
      params.source.path,
    );
    if (!isDeepStrictEqual(beforeCommit, params.source)) {
      throw new RuntimeSetupError(
        "setup_configuration_changed",
        "Configuration changed while setup was being saved. Refresh and try again.",
        409,
      );
    }
    const commit = async () => {
      await transaction.write(runtimeConfig, {
        expectedConfig: params.source.config,
      });
      configWritten = true;
      return createRuntimeSetupDraft(
        { config: runtimeConfig, path: params.configPath, exists: true },
        providers,
        params.input.provider,
        modelConfig,
        retained.ownedProviders,
      );
    };
    const commitWithCredentials =
      params.commitWithCredentials ??
      ((operation: typeof commit) => operation());
    const draft = await commitWithCredentials(commit);
    return { draft, embeddingInvalidated };
  } catch (error) {
    await rollbackScaffoldAfterFailure(
      error,
      configWritten,
      transaction,
      params.source,
      runtimeConfig,
    );
    await Promise.all(created.map(removeUnchangedSetupFile));
    throw error;
  }
}

async function rollbackScaffoldAfterFailure(
  error: unknown,
  configWritten: boolean,
  transaction: ConfigFileTransaction,
  source: InspectedRuntimeConfigFile,
  runtimeConfig: Record<string, unknown>,
): Promise<void> {
  if (!configWritten) return;
  try {
    await restoreSetupScaffoldConfig(transaction, source, runtimeConfig);
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      "Setup failed and its configuration could not be restored.",
    );
  }
}
