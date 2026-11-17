import type {
  ModelParameterConstraint, ModelParameterDiagnostic, ModelParameterKey,
  ModelParameterProfile, ModelParameterValue,
  ResolvedModelParameter,
} from "../../shared/model-parameters.js";
import { MODEL_PARAMETER_DEFINITIONS, validateModelParameterValue } from "../../shared/model-parameter-validation.js";
import type { ProviderParameterCapabilities } from "../providers/parameter-capabilities.js";

export function parameterConstraintIssue(value: ModelParameterValue, constraint: ModelParameterConstraint): string | undefined {
  if (constraint.supported === false) return "This parameter is not supported by the selected model.";
  if (constraint.values && !constraint.values.includes(value)) return "This value is not supported by the selected model.";
  if (typeof value !== "number") return undefined;
  if (constraint.min !== undefined && value < constraint.min) return `The selected model requires a value of at least ${constraint.min}.`;
  if (constraint.max !== undefined && value > constraint.max) return `The selected model requires a value of at most ${constraint.max}.`;
  return undefined;
}

export function resolveConstrainedParameter(params: {
  key: ModelParameterKey;
  value?: ModelParameterValue;
  profile?: ModelParameterProfile;
  providerConstraint?: ModelParameterConstraint;
  nativeSentinel?: boolean;
}): { value?: ModelParameterValue; warnings: ModelParameterDiagnostic[] } {
  const { key, profile } = params;
  let value = params.value;
  const warnings: ModelParameterDiagnostic[] = [];
  const warn = (code: string, message: string) => warnings.push({ code, key, ...(profile ? { profileId: profile.id } : {}), message });
  if (value === undefined) return { warnings };
  if (key === "reasoning_effort" && profile?.reasoning) {
    const reasoning = profile.reasoning;
    const effort = String(value);
    const supportsEffort = reasoning.efforts.includes(effort) && (effort !== "none" || reasoning.canDisableThinking === true);
    if (!supportsEffort) {
      const mapped = reasoning.mappings?.[effort];
      const mappingSupported = typeof mapped === "string" && reasoning.efforts.includes(mapped) && (mapped !== "none" || reasoning.canDisableThinking === true);
      value = mappingSupported ? mapped : undefined;
      warn(mappingSupported ? "model_reasoning_effort_mapped" : "model_reasoning_effort_omitted",
        mappingSupported ? `Requested effort ${effort} is sent as ${mapped}.` : `Requested effort ${effort} is not supported; the server selects its default.`);
    }
  }
  if (key === "thinking_budget" && value === 0 && profile?.reasoning?.canDisableThinking !== true && profile?.reasoning) {
    value = undefined;
    warn("model_thinking_off_unsupported", "Zero would disable thinking, which this model does not support; the budget is omitted.");
  }
  if (value === undefined) return { warnings };
  const scalarIssue = params.nativeSentinel ? undefined : validateModelParameterValue(key, value);
  const providerIssue = params.nativeSentinel || !params.providerConstraint ? undefined : parameterConstraintIssue(value, params.providerConstraint);
  const issue = scalarIssue ?? providerIssue
    ?? (profile?.constraints?.[key] ? parameterConstraintIssue(value, profile.constraints[key]!) : undefined);
  if (issue) {
    warn("model_parameter_value_omitted", issue);
    return { warnings };
  }
  return { value, warnings };
}

type RequirementResolution = {
  values: Partial<Record<ModelParameterKey, ModelParameterValue>>;
  fields: Partial<Record<ModelParameterKey, ResolvedModelParameter>>;
  profile?: ModelParameterProfile;
  capabilities: ProviderParameterCapabilities;
  warnings: ModelParameterDiagnostic[];
};

function isParameterRequirementSatisfied(requirement: NonNullable<ModelParameterConstraint["requires"]>,
  values: RequirementResolution["values"]): boolean {
  const value = values[requirement.key];
  if (value === undefined) return requirement.allowMissing === true;
  return requirement.values.includes(value);
}

function removeUnsatisfiedParameters(params: RequirementResolution): boolean {
  let changed = false;
  for (const { key } of MODEL_PARAMETER_DEFINITIONS) {
    if (params.values[key] === undefined) continue;
    const transport = params.capabilities.parameters[key];
    const requirements = [transport?.requires, params.profile?.constraints?.[key]?.requires ?? transport?.compatibility];
    const failed = requirements.find((requirement) => requirement && !isParameterRequirementSatisfied(requirement, params.values));
    if (!failed) continue;
    const warning: ModelParameterDiagnostic = { code: "model_parameter_requirement_unsatisfied", key,
      ...(params.profile ? { profileId: params.profile.id } : {}),
      message: `${key} requires a compatible ${failed.key} value and is omitted.` };
    delete params.values[key];
    params.fields[key] = { ...params.fields[key]!, value: undefined, omitted: true, warnings: [...params.fields[key]!.warnings, warning] };
    params.warnings.push(warning);
    changed = true;
  }
  return changed;
}

/** Removal is monotonic; at most one pass per registered parameter closes every chain. */
export function applyModelParameterRequirements(params: RequirementResolution): void {
  for (let remaining = MODEL_PARAMETER_DEFINITIONS.length; remaining > 0; remaining -= 1) {
    if (!removeUnsatisfiedParameters(params)) return;
  }
}
