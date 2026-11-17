import { MODEL_PARAMETER_DEFINITIONS } from "../../shared/model-parameter-validation.js";
import type {
  ModelParameterDiagnostic, ModelParameterKey, ModelParameterPresentation,
  ModelParameterControl, ModelParameterProfile, ModelParameterProfileCatalog, ModelParameterValue, ResolvedModelParameter, ResolvedModelParameters,
} from "../../shared/model-parameters.js";
import type { ModelGenerationConfig } from "../types.js";
import { matchModelParameterProfile } from "../model-parameter-profiles/matcher.js";
import { getProviderParameterCapabilities } from "../providers/parameter-capabilities.js";
import { resolveProviderParameterDefault } from "../providers/parameter-defaults.js";
import { diagnoseModelGenerationAliases, LEGACY_MODEL_PARAMETER_ALIASES } from "./model-generation-merge.js";
import { applyModelParameterRequirements, resolveConstrainedParameter } from "./model-parameter-constraints.js";
import { resolveModelParameterRecommendations } from "./model-parameter-recommendations.js";

export type ModelParameterResolutionInput = Readonly<{
  provider: string;
  model: string;
  generation?: ModelGenerationConfig;
  options?: Readonly<Record<string, unknown>>;
  catalog?: ModelParameterProfileCatalog;
  supportsThinking?: boolean;
  /** Adapter-calculated defaults become concrete only after the complete input envelope exists. */
  computedDefaults?: Partial<Record<ModelParameterKey, ModelParameterValue>>;
  /** Final reasoning policy output, after request and invocation overrides. */
  effectiveReasoning?: { effort?: string; budget?: number; overrideEffort?: boolean; overrideBudget?: boolean };
}>;

function legacyParameterValue(generation: ModelGenerationConfig, key: ModelParameterKey): ModelParameterValue | undefined {
  if (key === "thinking_budget") return generation.reasoningBudget?.mode === "tokens" ? generation.reasoningBudget.tokens : undefined;
  const alias = LEGACY_MODEL_PARAMETER_ALIASES[key as keyof typeof LEGACY_MODEL_PARAMETER_ALIASES];
  const value = alias ? generation[alias] : undefined;
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

function configuredParameterValue(generation: ModelGenerationConfig, key: ModelParameterKey, control: ModelParameterControl | undefined,
  recommended: ModelParameterValue | undefined, providerDefault: ReturnType<typeof resolveProviderParameterDefault>, computedDefault?: ModelParameterValue): {
    value?: ModelParameterValue; source: ResolvedModelParameter["source"]; nativeSentinel?: boolean } {
  if (control?.mode === "omit") return { source: "manual" };
  if (control?.mode === "value") return { value: control.value, source: "manual" };
  const legacy = legacyParameterValue(generation, key);
  if (legacy !== undefined) return { value: legacy, source: "configuration" };
  if (providerDefault?.value !== undefined) return providerDefault;
  if (control?.mode === "inherit" && recommended !== undefined) return { value: recommended, source: "profile" };
  if (computedDefault !== undefined) return { value: computedDefault, source: "provider" };
  if (providerDefault) return providerDefault;
  return { source: "server" };
}

function finalReasoningValue(input: ModelParameterResolutionInput, key: ModelParameterKey) {
  const reasoning = input.effectiveReasoning;
  if (!reasoning) return undefined;
  if (key === "reasoning_effort") return { value: reasoning.effort, override: reasoning.overrideEffort };
  if (key === "thinking_budget") return { value: reasoning.budget, override: reasoning.overrideBudget };
  return undefined;
}

function supportsDeclaredParameter(key: ModelParameterKey, transport: unknown, profile: ModelParameterProfile | undefined,
  supportsThinking: boolean | undefined): boolean {
  if (!transport || profile?.constraints?.[key]?.supported === false) return false;
  if (key !== "reasoning_effort" && key !== "thinking_budget") return true;
  if (profile?.reasoning) return true;
  return supportsThinking !== false;
}

function isUnverifiedExplicitOff(key: ModelParameterKey, value: ModelParameterValue | undefined,
  control: ModelParameterControl | undefined, profile: ModelParameterProfile | undefined): boolean {
  if (!control || control.mode === "omit" || profile?.reasoning?.canDisableThinking === true) return false;
  if (key === "reasoning_effort") return value === "none" && !profile?.reasoning;
  return key === "thinking_budget" && value === 0 && !profile?.reasoning;
}

function awaitsComputedProviderDefault(source: ResolvedModelParameter["source"], hasComputedDefault: boolean,
  supported: boolean, requested: ModelParameterValue | undefined): boolean {
  if (source !== "provider" || !hasComputedDefault || !supported) return false;
  return requested === undefined;
}

export function resolveModelParameters(input: ModelParameterResolutionInput): ResolvedModelParameters {
  const generation = input.generation ?? {};
  const matched = input.catalog ? matchModelParameterProfile(input.catalog, input.provider, input.model) : { diagnostics: [] };
  const profile = matched.profile;
  const capabilities = getProviderParameterCapabilities(input.provider);
  const controls = generation.parameters ?? {};
  const fields: Partial<Record<ModelParameterKey, ResolvedModelParameter>> = {};
  const values: Partial<Record<ModelParameterKey, ModelParameterValue>> = {};
  const warnings: ModelParameterDiagnostic[] = [...(input.catalog?.diagnostics ?? []), ...matched.diagnostics,
    ...(generation.parameterDiagnostics ?? []), ...diagnoseModelGenerationAliases(generation)];
  for (const definition of MODEL_PARAMETER_DEFINITIONS) {
    const key = definition.key;
    const control = controls[key];
    const providerConstraint = capabilities.parameters[key];
    const supported = supportsDeclaredParameter(key, providerConstraint, profile, input.supportsThinking);
    const recommended = profile?.defaults?.[key];
    const providerDefault = resolveProviderParameterDefault(capabilities, providerConstraint, input.options);
    const computedDefault = providerConstraint?.computedDefault ? input.computedDefaults?.[key] : undefined;
    const configured = configuredParameterValue(generation, key, control, recommended, providerDefault, computedDefault);
    let requested = configured.value;
    let source = configured.source;
    const reasoning = finalReasoningValue(input, key);
    if (reasoning && (control?.mode !== "omit" || reasoning.override)) {
      requested = reasoning.value;
      if (reasoning.override) source = "manual";
    }
    const unverifiedOff = isUnverifiedExplicitOff(key, requested, control, profile);
    if (unverifiedOff) requested = undefined;
    const constrained = resolveConstrainedParameter({ key, value: supported ? requested : undefined, profile, providerConstraint, nativeSentinel: configured.nativeSentinel });
    const fieldWarnings = [...constrained.warnings];
    if (unverifiedOff) fieldWarnings.push({ code: "model_thinking_off_unverified", key, message: "This model does not declare support for disabling thinking; the control is omitted." });
    if (!supported && requested !== undefined) fieldWarnings.push({ code: "model_parameter_unsupported", key, message: `${definition.label} is unsupported by the selected transport or model and is omitted.` });
    if (constrained.value !== undefined) values[key] = constrained.value;
    fields[key] = { key, ...(control ? { control } : {}), ...(constrained.value !== undefined ? { value: constrained.value } : {}),
      ...(recommended !== undefined ? { recommended } : {}), source, supported,
      modelSupport: modelParameterSupport(supported, !!profile),
      omitted: constrained.value === undefined && !awaitsComputedProviderDefault(source, !!providerConstraint?.computedDefault, supported, requested),
      explicit: control?.mode === "value" || control?.mode === "omit", ...(providerConstraint?.computedDefault && source === "provider" ? { note: providerConstraint.computedDefault } : {}), warnings: fieldWarnings };
    warnings.push(...fieldWarnings);
  }
  applyModelParameterRequirements({ values, fields, profile, capabilities, warnings });
  const recommendations = resolveModelParameterRecommendations({ profile, capabilities, values, fields });
  warnings.push(...recommendations.warnings);
  for (const { key } of MODEL_PARAMETER_DEFINITIONS) {
    const { recommended: _rawRecommendation, ...field } = fields[key]!;
    const recommended = recommendations.values[key];
    fields[key] = { ...field, ...(recommended !== undefined ? { recommended } : {}) };
  }
  return { values, controls, fields, ...(profile ? { profileId: profile.id,
    ...(profile.reasoning ? { canDisableThinking: profile.reasoning.canDisableThinking === true } : {}) } : {}), warnings };
}

function modelParameterSupport(supported: boolean, matched: boolean): ResolvedModelParameter["modelSupport"] {
  if (!supported) return "unsupported";
  return matched ? "supported" : "unknown";
}

function parameterPresentationNote(key: ModelParameterKey, field: ResolvedModelParameter, input: ModelParameterResolutionInput,
  conditional: boolean): Partial<ResolvedModelParameter> {
  if (field.control?.mode === "omit" || !field.supported) return {};
  const unknownRequestEffort = input.supportsThinking === true && !input.effectiveReasoning &&
    !input.generation?.reasoningEffort && !input.generation?.parameters?.reasoning_effort;
  if (!unknownRequestEffort) return {};
  if (key === "reasoning_effort") return { source: "provider", omitted: false, note: "Selected by request mode and per-step calibration." };
  if (conditional) return { note: "Sending this parameter depends on the request's effective reasoning mode." };
  return {};
}

export function resolveModelParameterPresentation(input: ModelParameterResolutionInput): ModelParameterPresentation {
  const result = resolveModelParameters(input);
  const profile = input.catalog?.profiles.find((entry) => entry.id === result.profileId);
  const capabilities = getProviderParameterCapabilities(input.provider);
  const parameters = MODEL_PARAMETER_DEFINITIONS.map((definition) => {
    const constraint = profile?.constraints?.[definition.key];
    const transport = capabilities.parameters[definition.key];
    const efforts = definition.key === "reasoning_effort" ? profile?.reasoning?.efforts : undefined;
    const minBounds = [definition.min, transport?.min, constraint?.min].filter((value): value is number => value !== undefined);
    const maxBounds = [definition.max, transport?.max, constraint?.max].filter((value): value is number => value !== undefined);
    const declaredValues = [definition.values, transport?.values, constraint?.values, efforts].filter((value) => value !== undefined);
    const availableValues = declaredValues[0]?.filter((value) => declaredValues.every((list) => list!.includes(value)));
    const values = definition.key === "reasoning_effort" ? availableValues?.filter((value) => value !== "none" || profile?.reasoning?.canDisableThinking === true) : availableValues;
    const field = result.fields[definition.key]!;
    return { ...definition, ...(minBounds.length ? { min: Math.max(...minBounds) } : {}),
      ...(maxBounds.length ? { max: Math.min(...maxBounds) } : {}), ...(values ? { values } : {}), ...field,
      ...parameterPresentationNote(definition.key, field, input, !!transport?.compatibility) };
  });
  return { parameters, ...(result.profileId ? { profileId: result.profileId } : {}), ...(profile?.notes ? { notes: profile.notes } : {}), warnings: result.warnings };
}
