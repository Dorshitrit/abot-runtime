import type {
  ModelGatewayPolicyConfig,
  ModelGatewayProfileConfig,
  ModelPreference,
} from "../../model-gateway/types.js";
import { resolveEffectiveInvocationProfile } from "../../shared/invocation-profile-selection.js";
import type { ModelStep } from "../../shared/model-steps.js";

export type ResolvedModelStepTimeout = Readonly<{
  timeoutMs: number;
  source: "runner" | "model_calibration";
  selectedProfileId?: string;
  calibrationSlotId?: string;
}>;

function resolveConfiguredProfile(
  profileId: string,
  policy?: ModelGatewayPolicyConfig,
): ModelGatewayProfileConfig | undefined {
  return policy?.profiles?.[profileId];
}

/** Resolves a model-specific step timeout without changing model selection. */
export function resolveModelStepTimeout(params: {
  modelStep: ModelStep;
  fallbackTimeoutMs: number;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
}): ResolvedModelStepTimeout {
  const selected = resolveEffectiveInvocationProfile({
    modelStep: params.modelStep,
    modelPreference: params.modelPreference,
    modelPolicy: params.modelPolicy,
    resolveProfile: resolveConfiguredProfile,
  });
  const selectedProfileId = selected?.profileId;
  const slotId = params.modelPolicy?.defaults?.steps?.[params.modelStep];
  const slotIsDirectSelection =
    !!slotId &&
    (!!params.modelPolicy?.invocationProfiles?.[slotId] ||
      !!params.modelPolicy?.profiles?.[slotId]);
  const calibration =
    selected && slotId && !slotIsDirectSelection
      ? selected.profile.calibration?.[slotId]
      : undefined;

  if (calibration?.timeoutMs !== undefined) {
    return {
      timeoutMs: calibration.timeoutMs,
      source: "model_calibration",
      selectedProfileId,
      calibrationSlotId: slotId,
    };
  }

  return {
    timeoutMs: params.fallbackTimeoutMs,
    source: "runner",
    ...(selectedProfileId ? { selectedProfileId } : {}),
  };
}
