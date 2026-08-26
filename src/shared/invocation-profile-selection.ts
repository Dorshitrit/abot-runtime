import type {
  ModelGatewayPolicyConfig,
  ModelInvocationProfileConfig,
  ModelPreference,
} from "../model-gateway/types.js";
import { resolveRuntimeModelRole } from "./model-role-policy.js";
import { isFastModelStep, isMainModelStep } from "./model-steps.js";
import type { ModelStep } from "./types.js";

export type InvocationProfileSource =
  | "clientPreference"
  | "default"
  | "modelStep"
  | "role";

export type InvocationProfileCandidate<TProfile> = {
  profileId: string;
  profile: TProfile;
  source: InvocationProfileSource;
  invocationProfileId?: string;
  invocationProfile?: ModelInvocationProfileConfig;
};

export type ProfileResolver<TProfile> = (
  profileId: string,
  policy?: ModelGatewayPolicyConfig,
) => TProfile | undefined;

export function normalizeProfileId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function normalizeModelPreference<TProfile>(
  value: unknown,
  policy: ModelGatewayPolicyConfig | undefined,
  resolveProfile: ProfileResolver<TProfile>,
): ModelPreference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const profileId = normalizeProfileId(
    (value as { profileId?: unknown }).profileId,
  );
  if (
    !profileId ||
    !resolveProfileCandidate({
      profileId,
      policy,
      source: "clientPreference",
      resolveProfile,
    })
  ) {
    return undefined;
  }

  const scope = (value as { scope?: unknown }).scope;
  return {
    profileId,
    scope: scope === "main" ? ("main" as const) : ("all" as const),
  };
}

export function resolveProfileCandidate<TProfile>(params: {
  profileId: unknown;
  policy?: ModelGatewayPolicyConfig;
  source: InvocationProfileSource;
  resolveProfile: ProfileResolver<TProfile>;
}): InvocationProfileCandidate<TProfile> | undefined {
  const profileId = normalizeProfileId(params.profileId);
  if (!profileId) {
    return undefined;
  }
  const invocationProfile = params.policy?.invocationProfiles?.[profileId];
  if (invocationProfile) {
    const baseProfileId = normalizeProfileId(invocationProfile.profileId);
    const profile = baseProfileId
      ? params.resolveProfile(baseProfileId, params.policy)
      : undefined;
    return profile && baseProfileId
      ? {
          profileId: baseProfileId,
          profile,
          source: params.source,
          invocationProfileId: profileId,
          invocationProfile,
        }
      : undefined;
  }

  const profile = params.resolveProfile(profileId, params.policy);
  return profile
    ? {
        profileId,
        profile,
        source: params.source,
      }
    : undefined;
}

export function resolveClientPreferenceProfile<TProfile>(params: {
  modelPreference?: unknown;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelStep?: ModelStep | string;
  resolveProfile: ProfileResolver<TProfile>;
}): InvocationProfileCandidate<TProfile> | undefined {
  const preference = normalizeModelPreference(
    params.modelPreference,
    params.modelPolicy,
    params.resolveProfile,
  );
  if (!preference) {
    return undefined;
  }

  if (preference.scope !== "all" && !isMainModelStep(params.modelStep)) {
    return undefined;
  }

  return resolveProfileCandidate({
    profileId: preference.profileId,
    policy: params.modelPolicy,
    source: "clientPreference",
    resolveProfile: params.resolveProfile,
  });
}

export function resolveConfiguredInvocationProfile<TProfile>(params: {
  taskType?: string;
  modelStep?: ModelStep | string;
  modelPolicy?: ModelGatewayPolicyConfig;
  includeStepFallback?: boolean;
  fallbackStepProfileId?: string;
  resolveProfile: ProfileResolver<TProfile>;
}): InvocationProfileCandidate<TProfile> | undefined {
  const step =
    typeof params.modelStep === "string" ? params.modelStep.trim() : "";
  const configuredStepProfileId = params.modelPolicy?.defaults?.steps?.[step];
  const stepProfile = resolveProfileCandidate({
    profileId: configuredStepProfileId,
    policy: params.modelPolicy,
    source: "modelStep",
    resolveProfile: params.resolveProfile,
  });
  if (stepProfile) {
    return stepProfile;
  }

  if (
    !configuredStepProfileId &&
    params.includeStepFallback &&
    isFastModelStep(step)
  ) {
    const profileId = normalizeProfileId(params.fallbackStepProfileId);
    const profile = profileId
      ? params.resolveProfile(profileId, params.modelPolicy)
      : undefined;
    if (profile && profileId) {
      return {
        profileId,
        profile,
        source: "modelStep",
      };
    }
  }

  const role = resolveRuntimeModelRole({
    modelStep: step,
  });
  const roleProfile = resolveProfileCandidate({
    profileId: role ? params.modelPolicy?.defaults?.roles?.[role] : undefined,
    policy: params.modelPolicy,
    source: "role",
    resolveProfile: params.resolveProfile,
  });
  if (roleProfile) {
    return roleProfile;
  }

  return resolveProfileCandidate({
    profileId: params.modelPolicy?.defaults?.profileId,
    policy: params.modelPolicy,
    source: "default",
    resolveProfile: params.resolveProfile,
  });
}

export function resolveEffectiveInvocationProfile<TProfile>(params: {
  taskType?: string;
  modelStep?: ModelStep | string;
  modelPreference?: unknown;
  modelPolicy?: ModelGatewayPolicyConfig;
  includeStepFallback?: boolean;
  fallbackStepProfileId?: string;
  resolveProfile: ProfileResolver<TProfile>;
}): InvocationProfileCandidate<TProfile> | undefined {
  const configuredProfile = resolveConfiguredInvocationProfile(params);
  const clientPreferenceProfile = resolveClientPreferenceProfile(params);

  return params.modelPolicy?.defaults?.overrideClientPreference === true
    ? (configuredProfile ?? clientPreferenceProfile)
    : (clientPreferenceProfile ?? configuredProfile);
}
