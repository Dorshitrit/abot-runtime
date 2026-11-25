import { getModelParameterDefinition } from "../../shared/model-parameter-validation.js";
import type { ModelParameterKey } from "../../shared/model-parameters.js";

export const MAX_PARAMETER_OMISSIONS = 9;
export const PARAMETER_OMISSION_REASONS = Object.freeze([
  "model_reasoning_effort_omitted", "model_parameter_unsupported", "model_parameter_value_omitted",
  "model_thinking_off_unsupported", "model_thinking_off_unverified", "model_parameter_requirement_unsatisfied",
] as const);
export type ParameterOmissionReason = typeof PARAMETER_OMISSION_REASONS[number];
export type ModelParameterOmission = Readonly<{
  parameter: ModelParameterKey;
  reasonCode: ParameterOmissionReason;
  requestedValue?: string;
}>;

export function isParameterOmissionReason(value: unknown): value is ParameterOmissionReason {
  return PARAMETER_OMISSION_REASONS.some((reason) => reason === value);
}

/** Only numeric/boolean scalars and declared enum literals; never arbitrary configured text. */
export function safeParameterRequestedValue(parameter: string, value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string" && value.length <= 32 && getModelParameterDefinition(parameter)?.values?.includes(value)) return value;
  return undefined;
}

function readRequestedValue(parameter: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  if (value === "true" || value === "false") return value;
  if (safeParameterRequestedValue(parameter, value) !== undefined) return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === value ? value : undefined;
}

export function readModelParameterOmissions(value: unknown): readonly ModelParameterOmission[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARAMETER_OMISSIONS) return undefined;
  const seen = new Set<string>();
  const result: ModelParameterOmission[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    const definition = typeof item.parameter === "string" ? getModelParameterDefinition(item.parameter) : undefined;
    if (!definition || seen.has(definition.key) || !isParameterOmissionReason(item.reasonCode)) return undefined;
    const requestedValue = readRequestedValue(definition.key, item.requestedValue);
    if (item.requestedValue !== undefined && requestedValue === undefined) return undefined;
    seen.add(definition.key);
    result.push(Object.freeze({ parameter: definition.key, reasonCode: item.reasonCode,
      ...(requestedValue !== undefined ? { requestedValue } : {}) }));
  }
  return Object.freeze(result);
}
