import type {
  ModelGatewayPolicyConfig,
  ModelGatewayProfileConfig,
  ModelPreference,
} from "../../model-gateway/types.js";
import { resolveAgentMode } from "../../shared/agent.js";
import { resolveProfileCandidate } from "../../shared/invocation-profile-selection.js";
import type { AgentMode } from "../../shared/types.js";
import {
  DEFAULT_REQUEST_EXECUTION_POLICY_ID,
  type RequestExecutionPolicySelection,
  type RuntimeModelExecutionPolicies,
} from "../config/model-execution-policy.js";

type ModelSelection = {
  agentMode: AgentMode;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
  execution: RequestExecutionPolicySelection;
};

function normalizeModelPreference(value: unknown): ModelPreference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const profileId = (value as { profileId?: unknown }).profileId;
  if (typeof profileId !== "string" || profileId.trim().length === 0) {
    return undefined;
  }
  const scope = (value as { scope?: unknown }).scope;
  return {
    profileId: profileId.trim(),
    scope: scope === "main" ? "main" : "all",
  };
}

function resolveConfiguredProfile(
  profileId: string,
  policy?: ModelGatewayPolicyConfig,
): ModelGatewayProfileConfig | undefined {
  return policy?.profiles?.[profileId];
}

/**
 * Resolves process policy from the request's canonical base profile. This is
 * intentionally independent of modelStep: step calibration happens inside an
 * already-selected request process, and both preference scopes include the
 * root invocation.
 */
function resolveRequestExecutionPolicy(params: {
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelExecutionPolicies?: RuntimeModelExecutionPolicies;
}): RequestExecutionPolicySelection {
  const preferred = resolveProfileCandidate({
    profileId: params.modelPreference?.profileId,
    policy: params.modelPolicy,
    source: "clientPreference",
    resolveProfile: resolveConfiguredProfile,
  });
  const configured = resolveProfileCandidate({
    profileId: params.modelPolicy?.defaults?.profileId,
    policy: params.modelPolicy,
    source: "default",
    resolveProfile: resolveConfiguredProfile,
  });
  const primary =
    params.modelPolicy?.defaults?.overrideClientPreference === true
      ? (configured ?? preferred)
      : (preferred ?? configured);
  const configuredExecution = primary
    ? params.modelExecutionPolicies?.[primary.profileId]
    : undefined;

  return Object.freeze({
    policy: configuredExecution?.policy ?? DEFAULT_REQUEST_EXECUTION_POLICY_ID,
    ...(primary ? { primaryProfileId: primary.profileId } : {}),
    source: configuredExecution ? "model_profile" : "default",
  });
}

export function resolveModelSelection(params: {
  agentMode: unknown;
  modelPreference: unknown;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelExecutionPolicies?: RuntimeModelExecutionPolicies;
}): ModelSelection {
  const modelPreference = normalizeModelPreference(params.modelPreference);
  return {
    agentMode: resolveAgentMode(params.agentMode),
    ...(modelPreference ? { modelPreference } : {}),
    ...(params.modelPolicy ? { modelPolicy: params.modelPolicy } : {}),
    execution: resolveRequestExecutionPolicy({
      ...(modelPreference ? { modelPreference } : {}),
      ...(params.modelPolicy ? { modelPolicy: params.modelPolicy } : {}),
      ...(params.modelExecutionPolicies
        ? { modelExecutionPolicies: params.modelExecutionPolicies }
        : {}),
    }),
  };
}
