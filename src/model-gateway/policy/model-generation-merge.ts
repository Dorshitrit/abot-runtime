import type { ModelParameterDiagnostic, ModelParameterKey } from "../../shared/model-parameters.js";
import type { ModelGenerationConfig } from "../types.js";

export const LEGACY_MODEL_PARAMETER_ALIASES = Object.freeze({
  temperature: "temperature", top_p: "topP", reasoning_effort: "reasoningEffort", thinking_budget: "reasoningBudget",
} satisfies Partial<Record<ModelParameterKey, keyof ModelGenerationConfig>>);

export function diagnoseModelGenerationAliases(layer: ModelGenerationConfig): ModelParameterDiagnostic[] {
  return Object.entries(LEGACY_MODEL_PARAMETER_ALIASES).flatMap(([key, alias]) => {
    if (!Object.hasOwn(layer, alias) || !layer.parameters?.[key as ModelParameterKey]) return [];
    return [{ code: "model_parameter_alias_shadowed", key: key as ModelParameterKey,
      message: `${key} control takes precedence over ${alias} in the same configuration layer.` }];
  });
}

/** Resolve each layer's spelling before overlaying; aliases never outrank a newer layer. */
export function mergeModelGenerationConfig(...layers: readonly (ModelGenerationConfig | undefined)[]): ModelGenerationConfig {
  const result: ModelGenerationConfig = {};
  const diagnostics: ModelParameterDiagnostic[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    const { parameters, parameterDiagnostics, ...ordinary } = layer;
    diagnostics.push(...(parameterDiagnostics ?? []), ...diagnoseModelGenerationAliases(layer));
    const controls = { ...result.parameters };
    const next = { ...ordinary };
    for (const [key, alias] of Object.entries(LEGACY_MODEL_PARAMETER_ALIASES)) {
      const control = parameters?.[key as ModelParameterKey];
      if (control) delete next[alias];
      if (!control && Object.hasOwn(ordinary, alias)) delete controls[key as ModelParameterKey];
    }
    Object.assign(result, next);
    for (const [key, control] of Object.entries(parameters ?? {})) {
      if (control.mode === "inherit") {
        if (!Object.hasOwn(controls, key)) controls[key as ModelParameterKey] = control;
        continue;
      }
      controls[key as ModelParameterKey] = control;
      const alias = LEGACY_MODEL_PARAMETER_ALIASES[key as keyof typeof LEGACY_MODEL_PARAMETER_ALIASES];
      if (alias) delete result[alias];
    }
    if (Object.keys(controls).length > 0) result.parameters = controls;
    else delete result.parameters;
  }
  if (diagnostics.length) result.parameterDiagnostics = [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()];
  return result;
}
