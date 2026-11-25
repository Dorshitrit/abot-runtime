import { createHash } from "node:crypto";
import type { ModelContextConfig, ModelGenerationConfig, ModelStepCalibrationConfig } from "../../model-gateway/types.js";
import { resolveModelSelection } from "../model/model-selection.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import type { AgentDefinition } from "./agent-records.js";
import type { AgentDecisionConfiguration } from "./decision-records.js";
import { createAgentModelBinding, type AgentModelConfiguration } from "./model-binding.js";
import { readAgentDecisionConfiguration } from "./decision-validation.js";

function generation(value: ModelGenerationConfig | undefined): unknown {
  if (!value) return null;
  return [value.parameters ?? null, value.temperature ?? null, value.topP ?? null,
    value.reasoningEffort ?? null, value.reasoningBudget ?? null, value.reasoningBudgetByMode ?? null];
}

function context(value: ModelContextConfig | undefined): unknown {
  if (!value) return null;
  return [value.formatTokenAccounting ?? null, value.tokenEstimation ?? null];
}

function calibration(value: Record<string, ModelStepCalibrationConfig> | undefined): unknown {
  return Object.keys(value ?? {}).sort().map((id) => {
    const slot = value![id]!;
    return [id, slot.profileId ?? null, slot.timeoutMs ?? null, generation(slot.generation),
      context(slot.context), slot.format ?? null, slot.instructions ?? null];
  });
}

function parameterProfiles(config: AgentModelConfiguration): unknown {
  const catalog = config.models?.parameterProfiles;
  if (!catalog) return null;
  return [catalog.schemaVersion, catalog.revision, catalog.profiles.map((profile) => [
    profile.schemaVersion, profile.id, profile.priority ?? null, profile.match,
    profile.defaults ?? null, profile.reasoning ?? null, profile.constraints ?? null,
  ])];
}

function fingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Captures definition, selected profile/alias controls, calibration and parameter profiles.
 * Only the digest is persisted. Provider configuration, endpoints, credentials, raw options,
 * display diagnostics and full request context are excluded. This is not an execution snapshot:
 * calibration target profiles, provider settings and tool availability require Phase 3 binding.
 */
export function captureAgentDecisionConfiguration(
  definition: AgentDefinition,
  config: AgentModelConfiguration,
): AgentDecisionConfiguration | null {
  const binding = createAgentModelBinding(config).inspect(definition);
  if (binding.status !== "configured") return null;
  const profile = config.models?.profiles?.[binding.baseProfileId];
  if (!profile) return null;
  const alias = config.models?.invocationProfiles?.[definition.modelProfileId];
  const authority = resolveRequestExecutionPolicy(binding.executionPolicy).authority;
  const { execution } = resolveModelSelection({
    agentMode: undefined, modelPreference: { profileId: definition.modelProfileId, scope: "all" },
    modelPolicy: config.models, modelExecutionPolicies: config.modelExecutionPolicies,
  });
  const policy = { id: binding.executionPolicy, source: execution.source, version: authority.version, definitionHash: authority.definitionHash };
  const digest = fingerprint([
    "agent_decision_configuration_v1",
    [definition.name, definition.icon, definition.basePrompt, definition.modelProfileId,
      definition.executionPolicy, definition.toolPermissionMode],
    [binding.baseProfileId, profile.model, profile.provider ?? null, profile.contextWindowTokens ?? null,
      profile.supportsThinking ?? null, profile.capabilities ?? null, generation(profile.generation),
      context(profile.context), calibration(profile.calibration)],
    alias ? [alias.profileId, generation(alias.generation), context(alias.context), alias.format ?? null] : null,
    parameterProfiles(config), policy,
  ]);
  return readAgentDecisionConfiguration({
    schemaVersion: 1, fingerprint: digest, modelProfileId: definition.modelProfileId,
    baseProfileId: binding.baseProfileId, policy, toolPermissionMode: definition.toolPermissionMode,
  });
}
