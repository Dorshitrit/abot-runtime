import { resolveProfileCandidate } from "../../shared/invocation-profile-selection.js";
import {
  ModelReasoningConfigurationError,
  parseModelReasoningPreference,
  supportsModelReasoningBudget,
  type ModelReasoningPreference,
} from "../../shared/model-reasoning.js";
import type { ModelGatewayPolicyConfig, ModelPreference } from "../../model-gateway/types.js";

/** Validate before session admission or tool effects; never infer a new model. */
export function captureRequestReasoningPreference(
  value: unknown,
  selection: {
    modelPreference?: ModelPreference;
    modelPolicy?: ModelGatewayPolicyConfig;
    execution: { primaryProfileId?: string };
  },
): ModelReasoningPreference | undefined {
  const preference = parseModelReasoningPreference(value);
  if (!preference) return undefined;
  const requestedId = selection.modelPreference?.profileId;
  const selectedId = requestedId
    ? resolveProfileCandidate({
        profileId: requestedId,
        policy: selection.modelPolicy,
        source: "clientPreference",
        resolveProfile: (id, policy) => policy?.profiles?.[id],
      })?.profileId ?? requestedId
    : selection.execution.primaryProfileId;
  if (selectedId !== preference.profileId) {
    throw new ModelReasoningConfigurationError(
      "reasoning_preference_profile_mismatch",
      "reasoning preference must bind the requested model profile",
    );
  }
  const profile = selection.modelPolicy?.profiles?.[preference.profileId];
  const provider = profile?.provider ? selection.modelPolicy?.providers?.[profile.provider] : undefined;
  if (!supportsModelReasoningBudget({
    provider: provider?.type ?? "",
    supportsThinking: profile?.supportsThinking,
  })) {
    throw new ModelReasoningConfigurationError(
      "reasoning_budget_unsupported",
      `profile ${preference.profileId} does not declare numeric reasoning controls`,
    );
  }
  return preference;
}
