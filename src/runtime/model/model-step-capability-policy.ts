import type {
  ModelGatewayPolicyConfig,
  ModelGatewayProfileConfig,
  ModelPreference,
} from "../../model-gateway/types.js";
import { resolveEffectiveInvocationProfile } from "../../shared/invocation-profile-selection.js";
import type { ModelStep } from "../../shared/types.js";

function resolveConfiguredProfile(
  profileId: string,
  policy?: ModelGatewayPolicyConfig,
): ModelGatewayProfileConfig | undefined {
  return policy?.profiles?.[profileId];
}

function resolveCalibrationProfileId(params: {
  modelStep: ModelStep | string;
  modelPolicy?: ModelGatewayPolicyConfig;
  resolvedProfileId: string;
  resolvedProfile: ModelGatewayProfileConfig;
}): string {
  const step =
    typeof params.modelStep === "string" ? params.modelStep.trim() : "";
  const slotId = step ? params.modelPolicy?.defaults?.steps?.[step] : "";
  if (!slotId) {
    return params.resolvedProfileId;
  }
  if (
    params.modelPolicy?.invocationProfiles?.[slotId] ||
    resolveConfiguredProfile(slotId, params.modelPolicy)
  ) {
    return params.resolvedProfileId;
  }
  const calibrationProfileId =
    params.resolvedProfile.calibration?.[slotId]?.profileId?.trim();
  return calibrationProfileId || params.resolvedProfileId;
}

export function resolvedModelStepImageAttachmentProfileId(params: {
  taskType?: string;
  modelStep: ModelStep | string;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelPreference?: ModelPreference;
}): string | undefined {
  const resolvedProfile = resolveEffectiveInvocationProfile({
    ...params,
    resolveProfile: resolveConfiguredProfile,
  });
  if (!resolvedProfile) {
    return undefined;
  }
  const profileId = resolveCalibrationProfileId({
    modelStep: params.modelStep,
    modelPolicy: params.modelPolicy,
    resolvedProfileId: resolvedProfile.profileId,
    resolvedProfile: resolvedProfile.profile,
  });
  const profile = resolveConfiguredProfile(profileId, params.modelPolicy);
  return profileReferencesConfiguredProvider({
    profileId,
    modelPolicy: params.modelPolicy,
  }) && profile?.capabilities?.inputModalities?.includes("image")
    ? profileId
    : undefined;
}

function profileReferencesConfiguredProvider(params: {
  profileId: string;
  modelPolicy?: ModelGatewayPolicyConfig;
}): boolean {
  const profile = params.modelPolicy?.profiles?.[params.profileId];
  const providerId = profile?.provider?.trim();
  return Boolean(
    providerId &&
    params.modelPolicy?.providers &&
    Object.hasOwn(params.modelPolicy.providers, providerId),
  );
}

export function resolvedModelStepSupportsImageAttachments(params: {
  taskType?: string;
  modelStep: ModelStep | string;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelPreference?: ModelPreference;
}): boolean {
  return resolvedModelStepImageAttachmentProfileId(params) !== undefined;
}
