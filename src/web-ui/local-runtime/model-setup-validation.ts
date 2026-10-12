import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { throwModelSetupValidationError } from "./model-setup-context-window.js";
import { loadRuntimeConfig } from "../../runtime/config.js";
import { isRecord } from "../../runtime/config/utils.js";
import { validateRuntimeConfigFile } from "../../runtime/config/validation.js";

/** Staging beside the selected source preserves every existing relative reference. */
export async function validateModelConfigurationChange(
  config: Record<string, unknown>,
  options: { rootDir: string; configPath: string; modelProfileId?: string },
): Promise<void> {
  validateRuntimeConfigFile(config, options.configPath);
  const temporary = join(
    dirname(options.configPath),
    `.model-addition-validation-${randomUUID()}.json`,
  );
  try {
    await writeFile(temporary, JSON.stringify(config), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const environment = isRecord(config.environment) ? config.environment : {};
    const profileIds = isRecord(environment.profiles)
      ? Object.keys(environment.profiles)
      : [];
    const environments = profileIds.length ? profileIds : [undefined];
    for (const environmentId of environments) {
      try {
        loadRuntimeConfig({
          rootDir: options.rootDir,
          configPath: temporary,
          profileId: environmentId,
          env: { ...process.env },
        });
      } catch (error) {
        throwModelSetupValidationError(
          error,
          options.modelProfileId,
          environmentId,
        );
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export { validateModelConfigurationChange as validateModelAddition };
