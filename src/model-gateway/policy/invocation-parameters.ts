import type { ModelGatewayRequest, ModelProfile, ResolvedModelInvocation } from "../types.js";
import { normalizeReasoning, resolveInvocationReasoning } from "./reasoning-policy.js";
import { resolveModelParameters } from "./model-parameter-resolution.js";
import type { ResolvedModelParameters } from "../../shared/model-parameters.js";

function isTerminalEffortOmission(parameters: ResolvedModelParameters): boolean {
  const field = parameters.fields.reasoning_effort;
  if (!field?.control) return false;
  if (field.control.mode === "omit") return true;
  return field.omitted && field.warnings.length > 0;
}

function preserveEffortOmissionDiagnostics(parameters: ResolvedModelParameters, preliminary: ResolvedModelParameters): ResolvedModelParameters {
  const field = parameters.fields.reasoning_effort;
  if (!field) return parameters;
  return { ...parameters, fields: { ...parameters.fields, reasoning_effort: { ...field,
    warnings: [...(preliminary.fields.reasoning_effort?.warnings ?? []), ...field.warnings] } } };
}

function diagnoseUnsupportedReasoningBudget(parameters: ResolvedModelParameters, hasBudget: boolean): ResolvedModelParameters {
  const field = parameters.fields.thinking_budget;
  if (!hasBudget || !field || field.supported || field.warnings.length > 0) return parameters;
  const warning = { code: "model_parameter_unsupported", key: "thinking_budget" as const,
    message: "The selected model does not support a reasoning budget; its configured server-default control is omitted." };
  return { ...parameters, fields: { ...parameters.fields, thinking_budget: { ...field, warnings: [warning] } },
    warnings: [...parameters.warnings, warning] };
}

/** Resolve controls only after the concrete provider/model and calibration are settled. */
export function resolveInvocationParameters(request: ModelGatewayRequest, profile: ModelProfile): Pick<ResolvedModelInvocation,
  "think" | "reasoningBudget" | "reasoningControlSource" | "parameters"> {
  const input = { provider: profile.provider, model: profile.model, generation: profile.generation,
    options: profile.options, catalog: request.modelPolicy?.parameterProfiles, supportsThinking: profile.supportsThinking };
  const preliminary = resolveModelParameters(input);
  if (!profile.generation.parameters && !preliminary.profileId) return resolveInvocationReasoning(request, profile);
  const generation = { ...profile.generation };
  const effortControl = generation.parameters?.reasoning_effort;
  const budgetControl = generation.parameters?.thinking_budget;
  if (effortControl) {
    delete generation.reasoningEffort;
    const effort = normalizeReasoning(preliminary.values.reasoning_effort);
    if (effort !== undefined) generation.reasoningEffort = effort;
  }
  if (budgetControl) {
    delete generation.reasoningBudget;
    if (budgetControl.mode !== "inherit") delete generation.reasoningBudgetByMode;
    const tokens = preliminary.values.thinking_budget;
    if (typeof tokens === "number") generation.reasoningBudget = { mode: "tokens", tokens };
  }
  const matchedProfile = request.modelPolicy?.parameterProfiles?.profiles.find((entry) => entry.id === preliminary.profileId);
  const selectedReasoningControl = preliminary.values.reasoning_effort !== undefined && !!effortControl;
  const selectedReasoningBudget = preliminary.values.thinking_budget !== undefined && !!budgetControl;
  const supportsThinking = profile.supportsThinking || (!!matchedProfile?.reasoning && (selectedReasoningControl || selectedReasoningBudget));
  const reasoning = resolveInvocationReasoning(request, { ...profile, generation, supportsThinking });
  const overrideEffort = normalizeReasoning(request.reasoningOverride) !== undefined || reasoning.reasoningControlSource === "request";
  const overrideBudget = reasoning.reasoningControlSource === "request";
  const preserveEffortOmission = !overrideEffort && isTerminalEffortOmission(preliminary);
  const suppressFallbackBudget = preserveEffortOmission && (preliminary.fields.reasoning_effort?.warnings.length ?? 0) > 0;
  const effectiveBudget = suppressFallbackBudget ? undefined : reasoning.reasoningBudget;
  let resolvedParameters = resolveModelParameters({ ...input, effectiveReasoning: {
    effort: preserveEffortOmission ? undefined : reasoning.think,
    budget: effectiveBudget?.mode === "tokens" ? effectiveBudget.tokens : undefined,
    overrideEffort, overrideBudget,
  } });
  if (preserveEffortOmission) resolvedParameters = preserveEffortOmissionDiagnostics(resolvedParameters, preliminary);
  resolvedParameters = diagnoseUnsupportedReasoningBudget(resolvedParameters, reasoning.reasoningBudget !== undefined);
  const parameters = { ...resolvedParameters,
    warnings: [...new Map([...preliminary.warnings, ...resolvedParameters.warnings].map((entry) => [JSON.stringify(entry), entry])).values()] };
  const preserveUnregisteredReasoning = !parameters.fields.reasoning_effort?.supported && !effortControl && !parameters.profileId;
  const think = preserveUnregisteredReasoning ? reasoning.think : normalizeReasoning(parameters.values.reasoning_effort);
  let reasoningBudget = reasoning.reasoningBudget;
  if (parameters.fields.thinking_budget?.supported === false) reasoningBudget = undefined;
  if (parameters.fields.thinking_budget?.omitted && budgetControl) reasoningBudget = undefined;
  if (parameters.fields.thinking_budget?.warnings.length) reasoningBudget = undefined;
  if (parameters.fields.reasoning_effort?.warnings.length && think === undefined) reasoningBudget = undefined;
  if (parameters.canDisableThinking === false && think === "none") reasoningBudget = undefined;
  const tokens = parameters.values.thinking_budget;
  if (typeof tokens === "number") reasoningBudget = { mode: "tokens", tokens };
  return { ...reasoning, think, reasoningBudget, parameters };
}
