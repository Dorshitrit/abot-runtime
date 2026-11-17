import registry from "./model-parameter-registry.json" with { type: "json" };
import type { ModelParameterControls, ModelParameterDefinition, ModelParameterKey } from "./model-parameters.js";

export const MODEL_PARAMETER_DEFINITIONS = Object.freeze(registry) as readonly ModelParameterDefinition[];

export function getModelParameterDefinition(key: string): ModelParameterDefinition | undefined {
  return MODEL_PARAMETER_DEFINITIONS.find((definition) => definition.key === key);
}

export function validateModelParameterValue(key: string, value: unknown): string | undefined {
  const definition = getModelParameterDefinition(key);
  if (!definition) return "unknown parameter";
  if (definition.type === "enum") return definition.values?.includes(value as never) ? undefined : "unsupported generic enum value";
  if (definition.type === "bool") return typeof value === "boolean" ? undefined : "expected boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return "expected finite number";
  if (definition.type === "int" && !Number.isSafeInteger(value)) return "expected safe integer";
  if (definition.min !== undefined && value < definition.min) return `minimum is ${definition.min}`;
  if (definition.max !== undefined && value > definition.max) return `maximum is ${definition.max}`;
  return undefined;
}

export function parseModelParameterControls(value: unknown): ModelParameterControls | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("model_parameters_expected_object");
  const result: ModelParameterControls = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!getModelParameterDefinition(key)) throw new TypeError(`model_parameter_unknown:${key}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`model_parameter_control_invalid:${key}`);
    const control = raw as Record<string, unknown>;
    const keys = Object.keys(control);
    if (control.mode === "inherit" || control.mode === "omit") {
      if (keys.length !== 1) throw new TypeError(`model_parameter_control_fields:${key}`);
      result[key as ModelParameterKey] = { mode: control.mode };
      continue;
    }
    if (control.mode !== "value" || keys.length !== 2 || !Object.hasOwn(control, "value")) throw new TypeError(`model_parameter_control_invalid:${key}`);
    const issue = validateModelParameterValue(key, control.value);
    if (issue) throw new TypeError(`model_parameter_value_invalid:${key}:${issue}`);
    result[key as ModelParameterKey] = { mode: "value", value: control.value as number | string | boolean };
  }
  return result;
}
