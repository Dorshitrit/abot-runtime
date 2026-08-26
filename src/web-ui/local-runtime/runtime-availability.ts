import { buildRuntimeModelConfiguration } from "../../runtime/config/builders.js";
import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import { isRecord } from "../../runtime/config/utils.js";
import { validateRuntimeConfigFile } from "../../runtime/config/validation.js";
import type { RuntimeSetupRequirement } from "./contracts.js";

function setupRequired(message: string): RuntimeSetupRequirement {
  return {
    status: "setup_required",
    code: "runtime_configuration_required",
    message,
  };
}

export function inspectRuntimeSetupRequirement(
  source: InspectedRuntimeConfigFile,
): RuntimeSetupRequirement | null {
  if (!source.exists) {
    return setupRequired(
      "No runtime configuration was found. Choose a provider and model to finish setup.",
    );
  }

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
      "No usable model provider is configured. Choose a provider and model to finish setup.",
    );
  }
  if (profiles.length === 0) {
    return setupRequired(
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
      "A model is configured, but the request-runner configuration is missing. Run the initializer to finish setup.",
    );
  }

  return null;
}
