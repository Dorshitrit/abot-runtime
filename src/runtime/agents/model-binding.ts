import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import type { ModelGatewayPolicyConfig, ModelGatewayProfileConfig } from "../../model-gateway/types.js";
import { resolveProfileCandidate, type InvocationProfileCandidate } from "../../shared/invocation-profile-selection.js";
import { resolveModelSelection } from "../model/model-selection.js";
import type { RuntimeConfig } from "../ports.js";
import type { AgentDefinition } from "./agent-records.js";
import type { AgentDefinitionInput, AgentModelBinding } from "./management-contracts.js";
import { readAgentDefinition, requireAgentFields, requireAgentText } from "./record-validation.js";
import { AgentStateError } from "./state-error.js";

export type AgentModelConfiguration = Pick<RuntimeConfig, "models" | "modelExecutionPolicies">;
type ProfileCandidate = InvocationProfileCandidate<ModelGatewayProfileConfig>;

function resolveConfiguredAgentProfile(profileId: string, policy?: ModelGatewayPolicyConfig) {
  return policy?.profiles?.[profileId];
}

function hasSameInvocationIdentity(selected: ProfileCandidate, configured: ProfileCandidate): boolean {
  if (selected.profileId !== configured.profileId) return false;
  return selected.invocationProfileId === configured.invocationProfileId;
}

function hasConflictingAgentModelOverride(
  selected: ProfileCandidate,
  configured: ProfileCandidate | undefined,
  policy: ModelGatewayPolicyConfig | undefined,
): boolean {
  if (policy?.defaults?.overrideClientPreference !== true) return false;
  if (!configured) return false;
  return !hasSameInvocationIdentity(selected, configured);
}

/** No fallback for a missing explicit selection; aliases retain their invocation overlays. */
function resolveAgentModelBinding(profileId: string, config: AgentModelConfiguration): AgentModelBinding {
  const selected = resolveProfileCandidate({
    profileId, policy: config.models, source: "clientPreference",
    resolveProfile: resolveConfiguredAgentProfile,
  });
  if (!selected) return { status: "unavailable", reason: "profile_missing" };
  const configured = resolveProfileCandidate({
    profileId: config.models?.defaults?.profileId, policy: config.models, source: "default",
    resolveProfile: resolveConfiguredAgentProfile,
  });
  if (hasConflictingAgentModelOverride(selected, configured, config.models))
    return { status: "unavailable", reason: "profile_overridden" };
  const { execution } = resolveModelSelection({
    agentMode: undefined,
    modelPreference: { profileId, scope: "all" },
    modelPolicy: config.models,
    modelExecutionPolicies: config.modelExecutionPolicies,
  });
  if (execution.primaryProfileId !== selected.profileId)
    return { status: "unavailable", reason: "profile_overridden" };
  return { status: "configured", baseProfileId: selected.profileId, executionPolicy: execution.policy };
}

/** One environment configuration snapshot; recomposition constructs a fresh binding owner. */
export function createAgentModelBinding(config: AgentModelConfiguration) {
  const captured = structuredClone({ models: config.models, modelExecutionPolicies: config.modelExecutionPolicies });
  function resolvePolicy(profileId: string): RequestExecutionPolicyId {
    const binding = resolveAgentModelBinding(profileId.trim(), captured);
    if (binding.status === "unavailable") throw new AgentStateError(`agents_model_${binding.reason}`);
    return binding.executionPolicy;
  }
  return Object.freeze({
    resolvePolicy,
    define(input: AgentDefinitionInput): AgentDefinition {
      const definition = requireAgentFields(input,
        ["name", "icon", "basePrompt", "modelProfileId", "toolPermissionMode", ...["defaultLimits", "onboarding"].filter((field) => Object.hasOwn(input, field))], "definition");
      requireAgentText(definition.modelProfileId, "definition.modelProfileId");
      const modelProfileId = definition.modelProfileId.trim();
      return readAgentDefinition({ ...definition, modelProfileId, executionPolicy: resolvePolicy(modelProfileId) });
    },
    inspect(definition: AgentDefinition): AgentModelBinding {
      const binding = resolveAgentModelBinding(definition.modelProfileId, captured);
      if (binding.status === "unavailable") return binding;
      if (binding.executionPolicy !== definition.executionPolicy)
        return { status: "unavailable", reason: "execution_policy_changed" };
      return binding;
    },
  });
}
