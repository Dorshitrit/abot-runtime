import { readDefaultContextWindowTokens } from "../../../scripts/runtime-setup-files.js";
import { getConfigDashboardSnapshot } from "../config-dashboard-backend.js";
import { inspectRuntimeConfigFileWithMeta } from "../../runtime/config/loader.js";
import { isRecord } from "../../runtime/config/utils.js";
import { validateRuntimeConfigFile } from "../../runtime/config/validation.js";
import { hasRuntimeSetupCredential } from "./runtime-setup-credentials.js";
import { ModelSetupError } from "./model-setup-input.js";

export type ModelSetupOptions = { rootDir: string; configPath?: string };

export function readModelSetupSource(options: ModelSetupOptions) {
  const source = inspectRuntimeConfigFileWithMeta(
    options.rootDir,
    options.configPath,
  );
  if (!source.exists)
    throw new ModelSetupError(
      "runtime_setup_required",
      "Complete initial setup before adding another model.",
      409,
    );
  validateRuntimeConfigFile(source.config, source.path);
  return source;
}

export function modelConfigMap(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export async function getModelSetupCatalog(options: ModelSetupOptions) {
  const source = readModelSetupSource(options);
  const models = modelConfigMap(source.config.models);
  const providers = await Promise.all(
    Object.entries(modelConfigMap(models.providers)).map(
      async ([id, value]) => {
        const provider = modelConfigMap(value);
        const type = String(provider.type);
        const requiresApiKey = type === "openai";
        const apiKeyEnv =
          typeof provider.apiKeyEnv === "string"
            ? provider.apiKeyEnv
            : "OPENAI_API_KEY";
        return {
          id,
          type,
          label: id,
          requiresApiKey,
          credentialConfigured:
            requiresApiKey &&
            (await hasRuntimeSetupCredential(options.rootDir, apiKeyEnv)),
        };
      },
    ),
  );
  const dashboard = await getConfigDashboardSnapshot(options);
  return {
    providers,
    defaultContextWindowTokens: await readDefaultContextWindowTokens(),
    profileIds: [
      ...new Set(dashboard.files.models.map((profile) => profile.id)),
    ],
  };
}
