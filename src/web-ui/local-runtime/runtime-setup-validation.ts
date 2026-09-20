import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRuntimeConfig } from "../../runtime/config.js";
import { isRecord } from "../../runtime/config/utils.js";

/** Validate complete effective configuration in isolation before replacing local files. */
export async function validateRuntimeSetupPlan(params: {
  rootDir: string;
  config: Record<string, unknown>;
  modelConfig: Record<string, unknown>;
  runnerPath: string;
  runnerConfig?: Record<string, unknown>;
}): Promise<void> {
  const staging = await mkdtemp(
    join(params.rootDir, ".runtime-setup-validation-"),
  );
  try {
    const runnerPath = params.runnerConfig
      ? join(staging, "runner.json")
      : params.runnerPath;
    if (params.runnerConfig)
      await writeFile(runnerPath, JSON.stringify(params.runnerConfig));
    const models = isRecord(params.config.models) ? params.config.models : {};
    const stagedConfig = {
      ...params.config,
      models: { ...models, profiles: { default: params.modelConfig } },
      requestRunner: { configRef: runnerPath },
    };
    const configPath = join(staging, "runtime.config.json");
    await writeFile(configPath, JSON.stringify(stagedConfig));
    const environment = isRecord(params.config.environment)
      ? params.config.environment
      : {};
    const profileIds = isRecord(environment.profiles)
      ? Object.keys(environment.profiles)
      : [];
    const environments = profileIds.length ? profileIds : [undefined];
    for (const profileId of environments)
      loadRuntimeConfig({ rootDir: params.rootDir, configPath, profileId });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
