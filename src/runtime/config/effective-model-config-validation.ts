import { validateEffectiveReasoningBudgets } from "./model-reasoning-validation.js";
import { validateLlamaCppProfileCapabilities } from "./llamacpp-profile-validation.js";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import {
  validateProfileContextCapacity,
  type ModelContextCapacityIssue,
} from "./model-context-capacity.js";
import type { RequestRunnerConfig } from "./runner/contracts.js";
import { RuntimeConfigValidationError } from "./validation.js";

function hasConfiguredProfile(
  profiles: NonNullable<ModelGatewayPolicyConfig["profiles"]>,
  profileId: string | undefined,
): boolean {
  return !!profileId && Object.hasOwn(profiles, profileId);
}

function hasConfiguredInvocationProfile(
  invocationProfiles: NonNullable<
    ModelGatewayPolicyConfig["invocationProfiles"]
  >,
  profileId: string | undefined,
): boolean {
  return !!profileId && Object.hasOwn(invocationProfiles, profileId);
}

function hasConfiguredCalibrationSlot(
  profiles: NonNullable<ModelGatewayPolicyConfig["profiles"]>,
  slotId: string,
): boolean {
  return Object.values(profiles).some((profile) =>
    Object.hasOwn(profile.calibration ?? {}, slotId),
  );
}

function validateProfileReference(params: {
  issues: string[];
  field: string;
  profileId: string;
  profiles: NonNullable<ModelGatewayPolicyConfig["profiles"]>;
}): void {
  if (!hasConfiguredProfile(params.profiles, params.profileId)) {
    params.issues.push(
      `${params.field} references unknown model profile ${params.profileId}`,
    );
  }
}

function validateInvocationTarget(params: {
  issues: string[];
  field: string;
  targetId: string;
  profiles: NonNullable<ModelGatewayPolicyConfig["profiles"]>;
  invocationProfiles: NonNullable<
    ModelGatewayPolicyConfig["invocationProfiles"]
  >;
}): void {
  if (
    !hasConfiguredProfile(params.profiles, params.targetId) &&
    !hasConfiguredInvocationProfile(params.invocationProfiles, params.targetId)
  ) {
    params.issues.push(
      `${params.field} references unknown model or invocation profile ${params.targetId}`,
    );
  }
}

function isImplicitRunnerStepTarget(params: {
  acceptsIdentityDefault?: boolean;
  stepId: string;
  targetId: string;
}): boolean {
  return (
    params.acceptsIdentityDefault === true && params.targetId === params.stepId
  );
}

function validateStepTarget(params: {
  issues: string[];
  field: string;
  stepId: string;
  targetId: string;
  profiles: NonNullable<ModelGatewayPolicyConfig["profiles"]>;
  invocationProfiles: NonNullable<
    ModelGatewayPolicyConfig["invocationProfiles"]
  >;
  acceptsIdentityDefault?: boolean;
}): void {
  if (isImplicitRunnerStepTarget(params)) {
    return;
  }
  if (
    hasConfiguredProfile(params.profiles, params.targetId) ||
    hasConfiguredInvocationProfile(
      params.invocationProfiles,
      params.targetId,
    ) ||
    hasConfiguredCalibrationSlot(params.profiles, params.targetId)
  ) {
    return;
  }
  params.issues.push(
    `${params.field} references unknown model profile, invocation profile, or calibration slot ${params.targetId}`,
  );
}

/**
 * Validates the fully materialized model policy against the strict runner
 * authority before the Runtime starts accepting requests.
 */
export function validateEffectiveRuntimeModelConfig(params: {
  configPath: string;
  modelPolicy?: ModelGatewayPolicyConfig;
  runnerConfig: RequestRunnerConfig;
}): void {
  const issues: string[] = [];
  const capacityIssues: ModelContextCapacityIssue[] = [];
  validateEffectiveReasoningBudgets(issues, params.modelPolicy);
  validateLlamaCppProfileCapabilities(issues, params.modelPolicy);
  const providers = params.modelPolicy?.providers ?? {};
  const profiles = params.modelPolicy?.profiles ?? {};
  const invocationProfiles = params.modelPolicy?.invocationProfiles ?? {};

  if (Object.keys(providers).length === 0) {
    issues.push("models.providers must declare at least one provider");
  }
  if (Object.keys(profiles).length === 0) {
    issues.push("models.profiles must declare at least one model profile");
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    const providerId = profile.provider?.trim();
    if (!providerId) {
      issues.push(
        `models.profiles.${profileId}.provider must be a non-empty string`,
      );
    } else if (!Object.hasOwn(providers, providerId)) {
      issues.push(
        `models.profiles.${profileId}.provider references unknown provider ${providerId}`,
      );
    }

    validateProfileContextCapacity({
      issues,
      capacityIssues,
      profileId,
      profile,
      ...(providerId && providers[providerId]
        ? { providerType: providers[providerId].type }
        : {}),
      runnerConfig: params.runnerConfig,
      ...(params.modelPolicy?.defaults?.context
        ? { defaultContext: params.modelPolicy.defaults.context }
        : {}),
    });

    for (const [slotId, calibration] of Object.entries(
      profile.calibration ?? {},
    )) {
      const calibrationProfileId = calibration.profileId?.trim();
      if (calibrationProfileId) {
        validateProfileReference({
          issues,
          field: `models.profiles.${profileId}.calibration.${slotId}.profileId`,
          profileId: calibrationProfileId,
          profiles,
        });
      }
    }
  }

  for (const [invocationProfileId, invocationProfile] of Object.entries(
    invocationProfiles,
  )) {
    validateProfileReference({
      issues,
      field: `models.invocationProfiles.${invocationProfileId}.profileId`,
      profileId: invocationProfile.profileId,
      profiles,
    });
  }

  const platformDefaults = params.modelPolicy?.defaults;
  const platformDefaultProfileId = platformDefaults?.profileId?.trim();
  if (platformDefaultProfileId) {
    validateProfileReference({
      issues,
      field: "models.defaults.profileId",
      profileId: platformDefaultProfileId,
      profiles,
    });
  }
  for (const [roleId, targetId] of Object.entries(
    platformDefaults?.roles ?? {},
  )) {
    validateInvocationTarget({
      issues,
      field: `models.defaults.roles.${roleId}`,
      targetId,
      profiles,
      invocationProfiles,
    });
  }
  for (const [stepId, targetId] of Object.entries(
    platformDefaults?.steps ?? {},
  )) {
    validateStepTarget({
      issues,
      field: `models.defaults.steps.${stepId}`,
      stepId,
      targetId,
      profiles,
      invocationProfiles,
    });
  }

  validateProfileReference({
    issues,
    field: "requestRunner.models.defaults.profileId",
    profileId: params.runnerConfig.models.defaults.profileId,
    profiles,
  });
  for (const [stepId, targetId] of Object.entries(
    params.runnerConfig.models.defaults.steps,
  )) {
    validateStepTarget({
      issues,
      field: `requestRunner.models.defaults.steps.${stepId}`,
      stepId,
      targetId,
      profiles,
      invocationProfiles,
      acceptsIdentityDefault: true,
    });
  }

  if (issues.length > 0) {
    throw new RuntimeConfigValidationError(
      params.configPath,
      issues,
      capacityIssues,
    );
  }
}
