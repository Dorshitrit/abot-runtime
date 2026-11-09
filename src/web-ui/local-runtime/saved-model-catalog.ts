import { buildRuntimeModelConfiguration } from "../../runtime/config/builders.js";
import { resolveRuntimeEnvironmentProfileSelection } from "../../runtime/config/environment.js";
import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import { createRequestModelPolicy } from "../../runtime/config/runner/model-policy.js";
import { projectRuntimeModelCatalog } from "../../runtime/model/model-catalog.js";
import { readConfiguredSetupRunner } from "./runtime-setup-provider.js";

/** An environment without an active owner previews saved files without changing owner caches. */
export function readSavedModelCatalog(
  source: InspectedRuntimeConfigFile,
  environmentId: string,
) {
  resolveRuntimeEnvironmentProfileSelection({
    config: source.config,
    profileId: environmentId,
    env: process.env,
  });
  const modelConfiguration = buildRuntimeModelConfiguration(source.config, {
    mainConfigPath: source.path,
  });
  const runnerConfig = readConfiguredSetupRunner(source);
  if (!runnerConfig) throw new Error("requestRunner.configRef is required");
  return projectRuntimeModelCatalog(
    createRequestModelPolicy({
      platformPolicy: modelConfiguration.modelPolicy,
      runnerConfig,
    }),
    modelConfiguration.executionPolicies,
  );
}
