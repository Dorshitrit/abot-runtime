import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildModelConfig,
  buildProviderConfig,
  readJsonObject,
  resolveRuntimePackageRoot,
} from "../../../scripts/runtime-setup-files.js";
import { withConfigFileTransaction } from "../../runtime/adapters/config-file-transaction.js";
import { inspectRuntimeConfigFileWithMeta } from "../../runtime/config/loader.js";
import {
  RuntimeSetupError,
  type RuntimeSetupInput,
} from "./runtime-setup-input.js";
import {
  isCurrentRuntimeSetupDraft,
  setupConfigurationChanged,
  setupConfigMap,
  writeRuntimeSetupDraft,
  type RuntimeSetupDraft,
} from "./runtime-setup-draft.js";
import { validateRuntimeSetupPlan } from "./runtime-setup-validation.js";
import { retainSetupConnectionProviders } from "./runtime-setup-provider-retention.js";
import { shouldInvalidateSetupEmbedding } from "./runtime-setup-embedding-invalidation.js";

function preserveExistingProvider(
  existing: unknown,
  requested: Record<string, unknown>,
  owned: boolean,
): void {
  if (existing === undefined) return;
  if (owned) return;
  if (isDeepStrictEqual(existing, requested)) return;
  throw new RuntimeSetupError(
    "setup_provider_conflict",
    "That provider already has settings. Its existing connection was preserved.",
    409,
  );
}

/** Applies only fields owned by the unfinished wizard, retaining optional-step edits. */
export async function editRuntimeSetupConnection(params: {
  rootDir: string;
  configPath: string;
  draft: RuntimeSetupDraft;
  input: RuntimeSetupInput;
  credentialChanged: boolean;
}): Promise<{ draft: RuntimeSetupDraft; embeddingInvalidated: boolean }> {
  return withConfigFileTransaction(
    params.configPath,
    async (configTransaction) => {
      const source = inspectRuntimeConfigFileWithMeta(
        params.rootDir,
        params.configPath,
      );
      if (!(await isCurrentRuntimeSetupDraft(source, params.draft)))
        throw setupConfigurationChanged();
      return withConfigFileTransaction(
        params.draft.modelPath,
        async (modelTransaction) => {
          if (
            !isDeepStrictEqual(
              modelTransaction.snapshot.config,
              params.draft.modelConfig,
            )
          )
            throw setupConfigurationChanged();
          const models = setupConfigMap(source.config.models);
          const providers = setupConfigMap(models.providers);
          const providerId = params.input.provider;
          const provider = buildProviderConfig(
            providerId,
            params.input.baseUrl,
          );
          const existing = providers[providerId];
          const owned = Object.hasOwn(params.draft.ownedProviders, providerId);
          preserveExistingProvider(existing, provider, owned);
          const embeddingInvalidated = shouldInvalidateSetupEmbedding({
            config: source.config,
            providerId,
            provider,
            providerChanged: !isDeepStrictEqual(existing, provider),
            credentialChanged: params.credentialChanged,
          });
          const modelTemplate = await readJsonObject(
            join(
              resolveRuntimePackageRoot(import.meta.dirname),
              "examples/models/default.config.json",
            ),
          );
          const contextWindowTokens =
            params.input.contextWindowTokens ??
            params.draft.modelConfig.contextWindowTokens;
          const modelConfig = buildModelConfig(
            modelTemplate,
            providerId,
            params.input.model,
            typeof contextWindowTokens === "number"
              ? contextWindowTokens
              : undefined,
          );
          const memory = setupConfigMap(source.config.longTermMemory);
          const retained = retainSetupConnectionProviders({
            providers,
            ownedProviders: params.draft.ownedProviders,
            embeddingProfiles: models.embeddingProfiles,
            providerId,
            provider,
          });
          const config = {
            ...source.config,
            models: {
              ...models,
              providers: retained.providers,
            },
            ...(embeddingInvalidated
              ? { longTermMemory: { ...memory, enabled: false } }
              : {}),
          };
          const runner = setupConfigMap(config.requestRunner);
          if (typeof runner.configRef !== "string")
            throw setupConfigurationChanged();
          await validateRuntimeSetupPlan({
            rootDir: params.rootDir,
            config,
            modelConfig,
            runnerPath: resolve(dirname(params.configPath), runner.configRef),
          });
          const nextDraft: RuntimeSetupDraft = {
            ...params.draft,
            revision: randomUUID(),
            modelConfig,
            ownedProviders: retained.ownedProviders,
          };
          let modelWritten = false;
          let configWritten = false;
          try {
            await modelTransaction.write(modelConfig, {
              expectedConfig: params.draft.modelConfig,
            });
            modelWritten = true;
            await configTransaction.write(config, {
              expectedConfig: source.config,
            });
            configWritten = true;
            await writeRuntimeSetupDraft(nextDraft);
          } catch (error) {
            if (configWritten)
              await configTransaction.write(source.config, {
                expectedConfig: config,
              });
            if (modelWritten)
              await modelTransaction.write(params.draft.modelConfig, {
                expectedConfig: modelConfig,
              });
            throw error;
          }
          return { draft: nextDraft, embeddingInvalidated };
        },
      );
    },
  );
}
