import type { ModelStep } from "../../shared/types.js";
import {
  normalizeModelPreference as normalizeSharedModelPreference,
  normalizeProfileId,
  resolveClientPreferenceProfile as resolveSharedClientPreferenceProfile,
  resolveConfiguredInvocationProfile as resolveSharedConfiguredInvocationProfile,
  resolveEffectiveInvocationProfile as resolveSharedEffectiveInvocationProfile,
  type InvocationProfileCandidate as SharedInvocationProfileCandidate,
  type InvocationProfileSource,
} from "../../shared/invocation-profile-selection.js";
import { getModelProfile } from "./model-registry.js";
import type {
  ModelGatewayPolicyConfig,
  ModelPreference,
  ModelProfile,
} from "../types.js";

export { normalizeProfileId, type InvocationProfileSource };

export type InvocationProfileCandidate =
  SharedInvocationProfileCandidate<ModelProfile>;

export function resolveProfileById(
  profileId: unknown,
  policy?: ModelGatewayPolicyConfig,
): ModelProfile | undefined {
  const normalized = normalizeProfileId(profileId);
  return normalized ? getModelProfile(normalized, policy) : undefined;
}

export function normalizeModelPreference(
  value: unknown,
  policy?: ModelGatewayPolicyConfig,
): ModelPreference | undefined {
  return normalizeSharedModelPreference(value, policy, getModelProfile);
}

export function resolveClientPreferenceProfile(params: {
  modelPreference?: unknown;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelStep?: ModelStep | string;
}): InvocationProfileCandidate | undefined {
  return resolveSharedClientPreferenceProfile({
    ...params,
    resolveProfile: getModelProfile,
  });
}

export function resolveConfiguredInvocationProfile(params: {
  taskType?: string;
  modelStep?: ModelStep | string;
  modelPolicy?: ModelGatewayPolicyConfig;
  includeStepFallback?: boolean;
}): InvocationProfileCandidate | undefined {
  return resolveSharedConfiguredInvocationProfile({
    ...params,
    resolveProfile: getModelProfile,
  });
}

export function resolveEffectiveInvocationProfile(params: {
  taskType?: string;
  modelStep?: ModelStep | string;
  modelPreference?: unknown;
  modelPolicy?: ModelGatewayPolicyConfig;
  includeStepFallback?: boolean;
}): InvocationProfileCandidate | undefined {
  return resolveSharedEffectiveInvocationProfile({
    ...params,
    resolveProfile: getModelProfile,
  });
}
