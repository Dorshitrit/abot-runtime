import { validateEffectiveRuntimeModelConfig } from "../../runtime/config/effective-model-config-validation.js";
import { buildRuntimeModelConfiguration } from "../../runtime/config/builders.js";
import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import { isRecord } from "../../runtime/config/utils.js";
import { validateRuntimeConfigFile } from "../../runtime/config/validation.js";
import { readConfiguredSetupRunner } from "./runtime-setup-provider.js";
import type { RuntimeSetupRequirement } from "./contracts.js";

function hasExistingSetupProfiles(source: InspectedRuntimeConfigFile): boolean {
  const models = isRecord(source.config.models) ? source.config.models : {};
  const profiles = isRecord(models.profiles) ? models.profiles : {};
  return Object.keys(profiles).length > 0;
}

function setupRequired(
  source: InspectedRuntimeConfigFile,
  message: string,
): RuntimeSetupRequirement {
  const hasExistingProfiles = hasExistingSetupProfiles(source);
  return {
    status: "setup_required",
    code: "runtime_configuration_required",
    message: hasExistingProfiles
      ? "Existing model profiles need attention. Open Models to repair their provider, model and request-runner settings."
      : message,
    ...(hasExistingProfiles ? { recovery: "configuration" as const } : {}),
  };
}

export function inspectRuntimeSetupRequirement(
  source: InspectedRuntimeConfigFile,
): RuntimeSetupRequirement | null {
  if (!source.exists) {
    return setupRequired(
      source,
      "No runtime configuration was found. Choose a provider and model to finish setup.",
    );
  }

  try {
    return inspectExistingRuntimeSetup(source);
  } catch (error) {
    if (!hasExistingSetupProfiles(source)) throw error;
    return setupRequired(source, "Review the existing configuration.");
  }
}

function inspectExistingRuntimeSetup(
  source: InspectedRuntimeConfigFile,
): RuntimeSetupRequirement | null {
  validateRuntimeConfigFile(source.config, source.path, {
    allowIncompleteSetup: true,
  });
  const modelPolicy = buildRuntimeModelConfiguration(source.config, {
    mainConfigPath: source.path,
  }).modelPolicy;
  const providers = modelPolicy?.providers ?? {};
  const profiles = Object.values(modelPolicy?.profiles ?? {});

  if (Object.keys(providers).length === 0) {
    return setupRequired(
      source,
      "No usable model provider is configured. Choose a provider and model to finish setup.",
    );
  }
  if (profiles.length === 0) {
    return setupRequired(
      source,
      "No model profile has a concrete model ID. Add a model connected to a declared provider.",
    );
  }

  const usableProfile = profiles.find((profile) => {
    const modelId = profile.model?.trim();
    const providerId = profile.provider?.trim();
    return !!modelId && !!providerId && Object.hasOwn(providers, providerId);
  });
  if (!usableProfile) {
    return setupRequired(
      source,
      "No model profile resolves to a declared provider. Connect a model profile to one of the configured providers.",
    );
  }

  const requestRunner = isRecord(source.config.requestRunner)
    ? source.config.requestRunner
    : undefined;
  if (
    typeof requestRunner?.configRef !== "string" ||
    requestRunner.configRef.trim().length === 0
  ) {
    return setupRequired(
      source,
      "A model is configured, but the request-runner configuration is missing. Run the initializer to finish setup.",
    );
  }

  const runnerConfig = readConfiguredSetupRunner(source);
  if (runnerConfig) {
    validateEffectiveRuntimeModelConfig({
      configPath: source.path,
      modelPolicy,
      runnerConfig,
    });
  }
  return null;
}
