import type { RuntimeConfig } from "../../ports.js";
import { resolveModelSelection } from "../../model/model-selection.js";
import { settingsFailure, SparkHomeSettingsError } from "./contracts.js";

/** HOME selects an existing EA profile explicitly; ordinary request defaults are not HOME defaults. */
export function resolveSparkHomeModel(config: RuntimeConfig, sparkProfile: string | null, homeProfile: string | null): string {
  if (!sparkProfile) return settingsFailure("spark_chat_model_required");
  if (!config.models?.profiles?.[sparkProfile]) return settingsFailure("spark_chat_model_unavailable");
  if (!homeProfile) return settingsFailure("spark_home_model_required");
  if (!config.models?.profiles?.[homeProfile]) return settingsFailure("spark_home_model_unavailable");
  const selection = resolveModelSelection({ agentMode: "reasoning", modelPreference: { profileId: homeProfile, scope: "all" },
    modelPolicy: config.models, modelExecutionPolicies: config.modelExecutionPolicies });
  if (selection.execution.primaryProfileId !== homeProfile) return settingsFailure("spark_home_model_unavailable");
  if (selection.execution.policy !== "execution-agent-v1") return settingsFailure("spark_home_execution_agent_required");
  return homeProfile;
}

export type SparkHomeModelOption = Readonly<{ id: string; label: string; providerId?: string; provider?: string }>;

export function listSparkHomeModels(config: RuntimeConfig, sparkProfile: string | null): readonly SparkHomeModelOption[] {
  return Object.freeze(Object.entries(config.models?.profiles ?? {}).flatMap(([id, profile]) => {
    try {
      resolveSparkHomeModel(config, sparkProfile, id);
      const providerId = profile.provider?.trim() || "";
      return [Object.freeze({ id, label: profile.label?.trim() || id,
        providerId, provider: config.models?.providers?.[providerId]?.type || providerId })];
    } catch (error) {
      if (!(error instanceof SparkHomeSettingsError)) throw error;
      return [];
    }
  }));
}
