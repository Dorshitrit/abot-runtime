import { MODEL_STEPS } from "../../shared/model-steps.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGatewayProfileCapabilities,
} from "../../model-gateway/types.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import type { RuntimeConfig } from "../ports.js";
import { resolvedModelStepSupportsImageAttachments } from "./model-step-capability-policy.js";

export type RuntimeModelCatalogProfile = {
  id: string;
  label: string;
  providerId: string;
  provider: string;
  model: string;
  supportsThinking: boolean;
  capabilities: ModelGatewayProfileCapabilities;
  supportsImageInput: boolean;
};

export type RuntimeModelCatalog = {
  defaultProfileId: string;
  profiles: RuntimeModelCatalogProfile[];
};

export function projectRuntimeModelCatalog(
  modelPolicy: ModelGatewayPolicyConfig | undefined,
): RuntimeModelCatalog {
  const providers = modelPolicy?.providers ?? {};
  const configuredProfiles = modelPolicy?.profiles ?? {};
  const defaultProfileId = modelPolicy?.defaults?.profileId?.trim();
  if (!defaultProfileId) {
    throw new Error(
      "Invalid runtime model catalog: models.defaults.profileId must be configured",
    );
  }
  if (!configuredProfiles[defaultProfileId]) {
    throw new Error(
      `Invalid runtime model catalog: models.defaults.profileId references unknown model profile ${defaultProfileId}`,
    );
  }

  const profiles = Object.entries(configuredProfiles).map(
    ([id, profile]): RuntimeModelCatalogProfile => {
      const providerId = profile.provider?.trim();
      if (!providerId) {
        throw new Error(
          `Invalid runtime model catalog: models.profiles.${id}.provider must be configured`,
        );
      }
      const providerConfig = providers[providerId];
      if (!providerConfig) {
        throw new Error(
          `Invalid runtime model catalog: models.profiles.${id}.provider references unknown provider ${providerId}`,
        );
      }
      return {
        id,
        label: profile.label?.trim() || id,
        providerId,
        provider: providerConfig.type,
        model: profile.model,
        supportsThinking: profile.supportsThinking === true,
        capabilities: profile.capabilities ?? {
          inputModalities: ["text"],
          outputModalities: ["text"],
        },
        supportsImageInput: resolvedModelStepSupportsImageAttachments({
          modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
          modelPolicy,
          modelPreference: { profileId: id },
        }),
      };
    },
  );

  return {
    defaultProfileId,
    profiles,
  };
}

export function loadRuntimeModelCatalog(
  config: RuntimeConfig,
): RuntimeModelCatalog {
  const runnerConfig = loadRequestRunnerConfig({
    configPath: config.requestRunner.configPath,
  });
  return projectRuntimeModelCatalog(
    createRequestModelPolicy({
      platformPolicy: config.models,
      runnerConfig,
    }),
  );
}
