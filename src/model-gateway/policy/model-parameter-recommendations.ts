import type {
  ModelParameterDiagnostic, ModelParameterKey, ModelParameterProfile, ModelParameterValue, ResolvedModelParameter,
} from "../../shared/model-parameters.js";
import type { ProviderParameterCapabilities } from "../providers/parameter-capabilities.js";
import { applyModelParameterRequirements, resolveConstrainedParameter } from "./model-parameter-constraints.js";

/** Preview exactly the supported preset that Apply recommended can materialize together. */
export function resolveModelParameterRecommendations(params: {
  profile?: ModelParameterProfile;
  capabilities: ProviderParameterCapabilities;
  values: Partial<Record<ModelParameterKey, ModelParameterValue>>;
  fields: Partial<Record<ModelParameterKey, ResolvedModelParameter>>;
}): { values: Partial<Record<ModelParameterKey, ModelParameterValue>>; warnings: ModelParameterDiagnostic[] } {
  const values = { ...params.values };
  const fields = { ...params.fields };
  const recommendedKeys: ModelParameterKey[] = [];
  const discardedWarnings: ModelParameterDiagnostic[] = [];
  for (const [rawKey, requested] of Object.entries(params.profile?.defaults ?? {})) {
    const key = rawKey as ModelParameterKey;
    const field = fields[key];
    if (!field?.supported) continue;
    recommendedKeys.push(key);
    const result = resolveConstrainedParameter({ key, value: requested, profile: params.profile,
      providerConstraint: params.capabilities.parameters[key] });
    if (result.value === undefined) delete values[key];
    else values[key] = result.value;
    fields[key] = { ...field, value: result.value, omitted: result.value === undefined, warnings: result.warnings };
  }
  applyModelParameterRequirements({ values, fields, profile: params.profile, capabilities: params.capabilities, warnings: discardedWarnings });
  const recommendations: Partial<Record<ModelParameterKey, ModelParameterValue>> = {};
  const warnings: ModelParameterDiagnostic[] = [];
  for (const key of recommendedKeys) {
    if (values[key] !== undefined) {
      recommendations[key] = values[key];
      continue;
    }
    warnings.push({ code: "model_parameter_recommendation_omitted", key, profileId: params.profile!.id,
      message: `The profile recommendation for ${key} is incompatible with the selected transport, model or other preset values.` });
  }
  return { values: recommendations, warnings };
}
