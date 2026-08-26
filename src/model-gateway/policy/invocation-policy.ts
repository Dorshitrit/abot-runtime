import type { ModelReasoningLevel } from "../../shared/types.js";
import {
  type InvocationProfileCandidate,
  normalizeModelPreference,
  resolveClientPreferenceProfile,
  resolveConfiguredInvocationProfile,
  resolveProfileById,
} from "./invocation-profile-policy.js";
import type {
  ModelGatewayRequest,
  ModelGatewayPolicyConfig,
  ModelInvocationProfileConfig,
  ModelProfile,
  ResolvedModelInvocation,
} from "../types.js";

export type ModelInvocationResolutionErrorCode =
  | "invalid_model_preference"
  | "model_profile_required"
  | "unknown_model_profile";

export class ModelInvocationResolutionError extends Error {
  readonly statusCode = 400;

  constructor(
    readonly code: ModelInvocationResolutionErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ModelInvocationResolutionError";
  }
}

export function resolveThink(agentMode: unknown): ModelReasoningLevel {
  const mode = String(agentMode || "reasoning").toLowerCase();
  if (mode === "deep") return "high";
  if (mode === "fast") return "none";
  return "medium";
}

export function normalizeReasoning(
  value: unknown,
): ModelReasoningLevel | undefined {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  if (normalized === "high") return "high";
  if (normalized === "xhigh") return "xhigh";
  return undefined;
}

function applyInvocationProfileOverlay(
  candidate: InvocationProfileCandidate,
): ModelProfile {
  const overlay = candidate.invocationProfile;
  if (!overlay) {
    return candidate.profile;
  }

  return {
    ...candidate.profile,
    generation: {
      ...candidate.profile.generation,
      ...(overlay.generation ?? {}),
    },
    context: {
      ...candidate.profile.context,
      ...(overlay.context ?? {}),
    },
  };
}

function resolveModelStepCalibrationSlot(params: {
  modelPolicy?: ModelGatewayPolicyConfig;
  modelStep?: unknown;
}): string | undefined {
  const step =
    typeof params.modelStep === "string" ? params.modelStep.trim() : "";
  const mapped = step ? params.modelPolicy?.defaults?.steps?.[step] : undefined;
  if (!mapped) {
    return undefined;
  }
  if (
    params.modelPolicy?.invocationProfiles?.[mapped] ||
    resolveProfileById(mapped, params.modelPolicy)
  ) {
    return undefined;
  }
  return mapped;
}

function applyModelStepCalibration(params: {
  profile: ModelProfile;
  slotId?: string;
  modelPolicy?: ModelGatewayPolicyConfig;
  fallbackFormat?: ModelInvocationProfileConfig["format"];
}): {
  profile: ModelProfile;
  invocationProfile?: ModelInvocationProfileConfig;
  instructions?: string[];
} {
  if (!params.slotId) {
    return { profile: params.profile };
  }
  const calibration = params.profile.calibration?.[params.slotId];
  if (!calibration) {
    return { profile: params.profile };
  }
  const targetProfileId = calibration.profileId?.trim();
  const targetProfile = targetProfileId
    ? resolveProfileById(targetProfileId, params.modelPolicy)
    : params.profile;
  if (!targetProfile) {
    throw new ModelInvocationResolutionError(
      "unknown_model_profile",
      `calibration ${params.slotId} references unavailable profile ${targetProfileId}`,
    );
  }
  const invocationProfile: ModelInvocationProfileConfig = {
    profileId: targetProfile.id,
    ...(calibration.generation ? { generation: calibration.generation } : {}),
    ...(calibration.context ? { context: calibration.context } : {}),
    ...((calibration.format ?? params.fallbackFormat)
      ? { format: calibration.format ?? params.fallbackFormat }
      : {}),
  };
  return {
    profile: applyInvocationProfileOverlay({
      profileId: targetProfile.id,
      profile: targetProfile,
      source: "modelStep",
      invocationProfileId: params.slotId,
      invocationProfile,
    }),
    invocationProfile,
    ...(calibration.instructions && calibration.instructions.length > 0
      ? { instructions: calibration.instructions }
      : {}),
  };
}

function validateExplicitModelPreference(
  requestBody: ModelGatewayRequest,
): void {
  if (requestBody.modelPreference === undefined) {
    return;
  }
  const normalized = normalizeModelPreference(
    requestBody.modelPreference,
    requestBody.modelPolicy,
  );
  if (normalized) {
    return;
  }
  const rawProfileId =
    requestBody.modelPreference &&
    typeof requestBody.modelPreference === "object" &&
    !Array.isArray(requestBody.modelPreference) &&
    typeof (requestBody.modelPreference as { profileId?: unknown })
      .profileId === "string"
      ? (requestBody.modelPreference as { profileId: string }).profileId.trim()
      : "";
  if (rawProfileId) {
    throw new ModelInvocationResolutionError(
      "unknown_model_profile",
      `requested profile ${rawProfileId} is not available in model policy`,
    );
  }
  throw new ModelInvocationResolutionError(
    "invalid_model_preference",
    "modelPreference.profileId must identify a configured profile",
  );
}

export function resolveModelInvocation(
  requestBody: ModelGatewayRequest,
): ResolvedModelInvocation {
  validateExplicitModelPreference(requestBody);
  const overrideModel =
    typeof requestBody?.modelOverride === "string" &&
    requestBody.modelOverride.trim().length > 0
      ? requestBody.modelOverride.trim()
      : "";
  const configuredProfile = resolveConfiguredInvocationProfile({
    taskType:
      typeof requestBody?.taskType === "string" ? requestBody.taskType : "",
    modelStep: requestBody?.modelStep,
    modelPolicy: requestBody?.modelPolicy,
    includeStepFallback: true,
  });
  const clientPreferenceProfile = resolveClientPreferenceProfile({
    modelPreference: requestBody?.modelPreference,
    modelPolicy: requestBody?.modelPolicy,
    modelStep: requestBody?.modelStep,
  });
  const configOverridesClient =
    requestBody?.modelPolicy?.defaults?.overrideClientPreference === true;
  const selectedCandidate = configOverridesClient
    ? (configuredProfile ?? clientPreferenceProfile)
    : (clientPreferenceProfile ?? configuredProfile);
  if (!selectedCandidate) {
    const configuredDefault =
      requestBody.modelPolicy?.defaults?.profileId?.trim();
    throw new ModelInvocationResolutionError(
      "model_profile_required",
      configuredDefault
        ? `effective profile ${configuredDefault} is not available in model policy`
        : "model policy must resolve an effective configured profile",
    );
  }
  const baseProfile = applyInvocationProfileOverlay(selectedCandidate);
  const calibration = applyModelStepCalibration({
    profile: baseProfile,
    slotId: resolveModelStepCalibrationSlot({
      modelPolicy: requestBody?.modelPolicy,
      modelStep: requestBody?.modelStep,
    }),
    modelPolicy: requestBody?.modelPolicy,
    fallbackFormat: selectedCandidate.invocationProfile?.format,
  });
  const profile =
    overrideModel.length > 0
      ? { ...calibration.profile, model: overrideModel }
      : calibration.profile;
  const selectedInvocationProfile =
    calibration.invocationProfile ?? selectedCandidate.invocationProfile;
  const think =
    normalizeReasoning(requestBody?.reasoningOverride) ??
    profile.generation.reasoningEffort ??
    resolveThink(requestBody?.agentMode);

  return {
    model: profile.model,
    profile,
    think: profile.supportsThinking ? think : undefined,
    ...(selectedInvocationProfile?.format
      ? { format: selectedInvocationProfile.format }
      : {}),
    ...(calibration.instructions
      ? { instructions: calibration.instructions }
      : {}),
  };
}
