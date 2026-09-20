import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalConfigFilePath } from "../../runtime/adapters/config-file-transaction.js";
import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import { isRecord } from "../../runtime/config/utils.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

/** Recovery creates its own file instead of reclaiming an orphaned model. */
export async function planRuntimeSetupModelFile(
  configPath: string,
  recoveringDraft: boolean,
): Promise<{ path: string; configRef: string }> {
  const configDirectory = dirname(configPath);
  const configRef = "./models/default.config.json";
  const path = resolve(configDirectory, configRef);
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { path, configRef };
    throw error;
  }
  if (!recoveringDraft)
    throw new RuntimeSetupError(
      "setup_model_file_exists",
      "The default model file already exists and will be preserved.",
      409,
    );
  const recoveryRef = `./models/setup-${randomUUID()}.config.json`;
  return { path: resolve(configDirectory, recoveryRef), configRef: recoveryRef };
}

export async function runtimeSetupDraftModelPath(
  source: InspectedRuntimeConfigFile,
): Promise<string | undefined> {
  const models = source.config.models;
  if (!isRecord(models) || !isRecord(models.profiles)) return undefined;
  const profile = models.profiles.default;
  if (!isRecord(profile)) return undefined;
  if (typeof profile.configRef !== "string" || !profile.configRef.trim())
    return undefined;
  return canonicalConfigFilePath(
    resolve(dirname(source.path), profile.configRef.trim()),
  );
}
