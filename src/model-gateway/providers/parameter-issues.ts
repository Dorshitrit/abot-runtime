import { randomUUID } from "node:crypto";
import { MODEL_PARAMETER_DEFINITIONS } from "../../shared/model-parameter-validation.js";
import type { ModelParameterKey, ResolvedModelParameter, ResolvedModelParameters } from "../../shared/model-parameters.js";
import type { ModelIssueDiagnostic } from "../protocol/model-issue.js";
import { isParameterOmissionReason, MAX_PARAMETER_OMISSIONS, safeParameterRequestedValue, type ModelParameterOmission } from "../protocol/parameter-omissions.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../types.js";
import { normalizeReasoning } from "../policy/reasoning-policy.js";

type ParameterIssueInput = Readonly<{
  invocation: ResolvedModelInvocation;
  requestBody?: Pick<ModelGatewayRequest, "reasoningOverride" | "reasoningPreference">;
  operation: ModelIssueDiagnostic["operation"];
  parameters?: ResolvedModelParameters;
  onIssue?: (issue: ModelIssueDiagnostic) => void;
}>;

/** Read the request's authoritative override; never reinterpret a discarded value from warning prose. */
function reasoningOverrideValue(params: ParameterIssueInput, key: ModelParameterKey): { overridden: boolean; value?: unknown } {
  if (key !== "reasoning_effort" && key !== "thinking_budget") return { overridden: false };
  const override = normalizeReasoning(params.requestBody?.reasoningOverride);
  if (key === "reasoning_effort" && override !== undefined) return { overridden: true, value: override };
  const source = params.invocation.reasoningControlSource;
  if (source === "invocation") return { overridden: true };
  if (source !== "request") return { overridden: false };
  const preference = params.requestBody?.reasoningPreference;
  if (key === "thinking_budget" && preference?.mode === "budget") return { overridden: true, value: preference.budgetTokens };
  if (key === "reasoning_effort" && (preference?.mode === "off" || (preference?.mode === "budget" && preference.budgetTokens === 0))) {
    return { overridden: true, value: "none" };
  }
  return { overridden: true };
}

function omittedParameterRequestedValue(
  params: ParameterIssueInput,
  field: ResolvedModelParameter,
  override: ReturnType<typeof reasoningOverrideValue>,
): string | undefined {
  if (override.overridden) return safeParameterRequestedValue(field.key, override.value);
  const generation = params.invocation.profile.generation;
  const configuredBudgetMayOverrideEffort = field.key === "reasoning_effort" &&
    (generation.reasoningBudget !== undefined || generation.reasoningBudgetByMode !== undefined);
  if (configuredBudgetMayOverrideEffort) return undefined;
  if (field.control?.mode === "value") return safeParameterRequestedValue(field.key, field.control.value);
  return undefined;
}

/** Observe the already prepared payload's resolution; never recalculate or change provider controls. */
export function observeParameterOmissions(params: ParameterIssueInput): void {
  if (!params.onIssue) return;
  const original = params.invocation.parameters;
  const parameters = params.parameters ?? original;
  if (!parameters) return;
  const omissions: ModelParameterOmission[] = [];
  for (const { key } of MODEL_PARAMETER_DEFINITIONS) {
    const field = parameters.fields[key];
    if (!field?.omitted || field.value !== undefined) continue;
    const override = reasoningOverrideValue(params, key);
    if (field.control?.mode === "omit" && !override.overridden) continue;
    // A server-default budget is an intentional omission, even when a legacy diagnostic describes it.
    if (key === "thinking_budget" && field.source === "server" && !field.control) continue;
    // Late computed allowances may retain an earlier rejected control only in the initial field diagnostics.
    const warnings = [...field.warnings, ...(original?.fields[key]?.warnings ?? [])];
    const reasonCode = warnings.find((warning) => warning.key === key && isParameterOmissionReason(warning.code))?.code;
    if (!isParameterOmissionReason(reasonCode)) continue;
    const requestedValue = omittedParameterRequestedValue(params, field, override);
    omissions.push(Object.freeze({ parameter: key, reasonCode,
      ...(requestedValue !== undefined ? { requestedValue } : {}) }));
  }
  if (!omissions.length) return;
  const profile = params.invocation.profile;
  const issue: ModelIssueDiagnostic = Object.freeze({
    issueId: randomUUID(), occurredAt: Date.now(), code: "model_parameter_omitted",
    // This settles the local adjustment only; it makes no claim about the subsequent provider call.
    outcome: "recovered", recovery: "parameter_omitted", operation: params.operation,
    profileId: profile.id, providerId: profile.providerId, provider: profile.provider,
    model: params.invocation.model, parameterOmissions: Object.freeze(omissions.slice(0, MAX_PARAMETER_OMISSIONS)),
  });
  try { params.onIssue(issue); } catch { /* Passive diagnostics cannot change invocation behavior. */ }
}
