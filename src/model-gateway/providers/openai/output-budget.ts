import { matchModelParameterProfile } from "../../model-parameter-profiles/matcher.js";
import { ModelProviderContextWindowExceededError } from "../../observability/context-window-guard.js";
import { resolveModelParameters } from "../../policy/model-parameter-resolution.js";
import { applyModelParameterRequirements } from "../../policy/model-parameter-constraints.js";
import type { ModelParameterKey, ModelParameterProfile, ResolvedModelParameters } from "../../../shared/model-parameters.js";
import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import { createProviderTraceContext } from "../../observability/provider-trace-context.js";
import type { ModelProviderInvocationParams } from "../contracts.js";
import { resolveProviderEnvelopeInputTokens } from "../envelope-budget.js";
import { getProviderParameterCapabilities, type ProviderParameterCapabilities } from "../parameter-capabilities.js";

function preserveExistingControls(original: ResolvedModelParameters | undefined, resolved: ResolvedModelParameters,
  profile: ModelParameterProfile | undefined, capabilities: ProviderParameterCapabilities): ResolvedModelParameters {
  const baseline = original ?? resolved;
  const values = { ...baseline.values, max_output_tokens: resolved.values.max_output_tokens };
  const fields = { ...baseline.fields, max_output_tokens: resolved.fields.max_output_tokens };
  const warnings = [...baseline.warnings, ...resolved.fields.max_output_tokens!.warnings];
  // Check dependencies against the controls actually retained in the final payload.
  applyModelParameterRequirements({ values, fields, profile, capabilities, warnings });
  const conflicts = Object.keys(baseline.values).some((key) => key !== "max_output_tokens"
    && baseline.values[key as ModelParameterKey] !== values[key as ModelParameterKey]);
  if (conflicts) {
    const warning = { code: "model_parameter_requirement_unsatisfied", key: "max_output_tokens" as const,
      message: "The calculated output allowance conflicts with an existing parameter requirement and is omitted." };
    fields.max_output_tokens = { ...fields.max_output_tokens!, value: undefined, omitted: true,
      warnings: [...fields.max_output_tokens!.warnings, warning] };
  }
  const field = fields.max_output_tokens!;
  return { ...baseline, values: { ...baseline.values, max_output_tokens: field.value },
    fields: { ...baseline.fields, max_output_tokens: field },
    warnings: [...new Map([...baseline.warnings, ...field.warnings].map((warning) => [JSON.stringify(warning), warning])).values()] };
}

/** Apply only the missing output allowance; preserve the already-resolved controls. */
export function applyOpenAIComputedOutputBudget(
  params: ModelProviderInvocationParams,
  payload: Record<string, unknown>,
): ResolvedModelParameters | undefined {
  const { invocation, requestBody } = params;
  const { profile } = invocation;
  const original = invocation.parameters;
  const control = profile.generation.parameters?.max_output_tokens;
  if (control?.mode === "value" || control?.mode === "omit") return original;
  if (payload.max_output_tokens !== undefined) return original;

  const catalog = requestBody.modelPolicy?.parameterProfiles;
  const matched = catalog ? matchModelParameterProfile(catalog, profile.provider, invocation.model).profile : undefined;
  const constraint = matched?.constraints?.max_output_tokens;
  if (constraint?.supported === false) return original;
  // An inherited recommendation keeps its existing precedence, including invalid-value diagnostics.
  if (control?.mode === "inherit" && matched?.defaults?.max_output_tokens !== undefined) return original;
  const capabilities = getProviderParameterCapabilities(profile.provider);
  const ceilings = [capabilities.modelOutputTokenLimits?.[invocation.model], constraint?.max]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (!ceilings.length) {
    traceDebug("model-gateway.server", "provider.output_budget.assessed", {
      ...createProviderTraceContext(params), outcome: "provider_default", reason: "model_output_ceiling_unknown",
    });
    return original;
  }

  const assessment = resolveProviderEnvelopeInputTokens({ payload,
    tokenEstimation: profile.context.tokenEstimation, measurement: params.inputTokenMeasurement });
  // Old saved policies and standalone gateway clients do not carry a runner reserve.
  const reserve = requestBody.modelPolicy?.outputSafetyReserveTokens ?? 0;
  const allowance = Math.floor(Math.min(...ceilings,
    profile.contextWindowTokens - assessment.inputTokens - reserve));
  // Responses requires at least 16 output tokens; do not overdraw the remaining context.
  if (allowance < Math.max(16, constraint?.min ?? 0)) throw new ModelProviderContextWindowExceededError();

  const requestOverride = invocation.reasoningControlSource === "request";
  const resolved = resolveModelParameters({ provider: profile.provider, model: invocation.model,
    generation: profile.generation, options: profile.options, catalog, supportsThinking: profile.supportsThinking,
    computedDefaults: { max_output_tokens: allowance },
    effectiveReasoning: { effort: invocation.think,
      budget: invocation.reasoningBudget?.mode === "tokens" ? invocation.reasoningBudget.tokens : undefined,
      overrideEffort: requestOverride || invocation.reasoningControlSource === "invocation", overrideBudget: requestOverride } });
  // Late resolution must not revive reasoning or sampling discarded by invocation policy.
  const parameters = preserveExistingControls(original, resolved, matched, capabilities);
  const field = parameters.fields.max_output_tokens!;
  if (typeof field.value === "number") payload.max_output_tokens = field.value;
  traceDebug("model-gateway.server", "provider.output_budget.assessed", {
    ...createProviderTraceContext(params), outcome: field.value === undefined ? "parameter_omitted" : "computed",
    modelOutputCeilingTokens: Math.min(...ceilings), contextWindowTokens: profile.contextWindowTokens,
    inputTokens: assessment.inputTokens, measurement: assessment.measurement, measurementBinding: assessment.measurementBinding,
    safetyReserveTokens: reserve, maxOutputTokens: field.value,
  });
  return parameters;
}
