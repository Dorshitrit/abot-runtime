import type { ModelGatewayPolicyConfig } from "../../../model-gateway/types.js";
import type { RequestRunnerConfig } from "./contracts.js";

export function createRequestModelPolicy(params: {
  platformPolicy?: ModelGatewayPolicyConfig;
  runnerConfig: RequestRunnerConfig;
}): ModelGatewayPolicyConfig {
  const platformDefaults = params.platformPolicy?.defaults;

  return {
    ...(params.platformPolicy?.providers
      ? { providers: params.platformPolicy.providers }
      : {}),
    ...(params.platformPolicy?.profiles
      ? { profiles: params.platformPolicy.profiles }
      : {}),
    ...(params.platformPolicy?.embeddingProfiles
      ? { embeddingProfiles: params.platformPolicy.embeddingProfiles }
      : {}),
    ...(params.platformPolicy?.invocationProfiles
      ? { invocationProfiles: params.platformPolicy.invocationProfiles }
      : {}),
    defaults: {
      ...(platformDefaults?.overrideClientPreference !== undefined
        ? {
            overrideClientPreference: platformDefaults.overrideClientPreference,
          }
        : {}),
      ...(platformDefaults?.context
        ? { context: platformDefaults.context }
        : {}),
      profileId: params.runnerConfig.models.defaults.profileId,
      steps: { ...params.runnerConfig.models.defaults.steps },
    },
  };
}
