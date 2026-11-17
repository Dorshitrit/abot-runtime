import { buildModelGenerationConfig, mergeModelProfileSources } from "../runtime/config/builders.js";
import { isRecord } from "../runtime/config/utils.js";
import { loadModelParameterProfileCatalog } from "../model-gateway/model-parameter-profiles/loader.js";
import { LEGACY_MODEL_PARAMETER_ALIASES, mergeModelGenerationConfig } from "../model-gateway/policy/model-generation-merge.js";
import { resolveModelParameterPresentation } from "../model-gateway/policy/model-parameter-resolution.js";
import { getProviderParameterCapabilities } from "../model-gateway/providers/parameter-capabilities.js";
import type { ModelGenerationConfig } from "../model-gateway/types.js";
import type { ModelParameterProfileCatalog } from "../shared/model-parameters.js";
import type { ConfigDashboardSnapshot, ConfigModelParameterPresentation, ConfigParameterPresentation } from "./config-dashboard-contracts.js";

type RawModel = Record<string, unknown>;
export type ModelParameterPreviewCandidate = {
  modelId: string;
  providers: Record<string, { type: string }>;
  models: Array<RawModel & { id: string }>;
};

function mapOf(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }

function configuredParameterValue(generation: ModelGenerationConfig, key: string) {
  const alias = LEGACY_MODEL_PARAMETER_ALIASES[key as keyof typeof LEGACY_MODEL_PARAMETER_ALIASES];
  const value = alias ? generation[alias] : undefined;
  if (key === "thinking_budget") return generation.reasoningBudget?.mode === "tokens" ? generation.reasoningBudget.tokens : undefined;
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

function projectGeneration(params: {
  target: RawModel; ownGeneration?: ModelGenerationConfig; generation?: ModelGenerationConfig;
  providers: Record<string, unknown>; catalog: ModelParameterProfileCatalog;
}): ConfigParameterPresentation {
  const provider = mapOf(params.providers[String(params.target.provider ?? "")]);
  const capabilities = getProviderParameterCapabilities(String(provider.type ?? ""));
  const resolved = resolveModelParameterPresentation({
    provider: String(provider.type ?? ""), model: String(params.target.model ?? ""),
    supportsThinking: params.target.supportsThinking === true,
    generation: params.generation, catalog: params.catalog,
    options: mapOf(params.target.options),
  });
  const own = params.ownGeneration ?? {};
  const parameters = resolved.parameters.map((field) => {
    const alias = LEGACY_MODEL_PARAMETER_ALIASES[field.key as keyof typeof LEGACY_MODEL_PARAMETER_ALIASES];
    const configuredValue = configuredParameterValue(own, field.key);
    const { control: _effectiveControl, ...effective } = field;
    const control = own.parameters?.[field.key];
    return { ...effective, source: field.source === "manual" ? "configuration" as const : field.source,
      ...(control ? { control } : {}), explicit: control?.mode === "value" || configuredValue !== undefined,
      ...(configuredValue !== undefined ? { configuredValue } : {}), ...(alias ? { legacyKeys: [alias] } : {}) };
  });
  const warnings = [...resolved.warnings];
  if (params.generation?.reasoningBudgetByMode) warnings.push({ code: "reasoning_budget_resolved_per_run", message: "Per-mode thinking budgets and request reasoning choices are resolved for each run." });
  if (own.reasoningBudget?.mode === "server-default") warnings.push({ code: "legacy_server_reasoning_budget", message: "Existing thinking budget uses the server budget and enables thinking. A deliberate edit replaces this saved behavior." });
  const nativeOptionKeys = capabilities.nativeOptions
    ? Object.values(capabilities.parameters).filter((entry) => entry.path[0] === "options").map((entry) => entry.path.at(-1)!)
    : [];
  return { ...resolved, parameters, warnings, nativeOptionKeys };
}

function unavailablePresentation(): ConfigParameterPresentation {
  return { parameters: [], warnings: [{ code: "model_parameter_config_invalid", message: "Parameter controls are unavailable until this model configuration is valid." }] };
}

function projectModel(model: RawModel | undefined, own: RawModel, models: Record<string, RawModel | undefined>, providers: Record<string, unknown>, catalog: ModelParameterProfileCatalog): ConfigModelParameterPresentation {
  if (!model) return { model: unavailablePresentation(), calibration: {} };
  try {
    const generation = model.generation as ModelGenerationConfig | undefined;
    const ownGeneration = buildModelGenerationConfig(own.generation);
    const calibration = Object.fromEntries(Object.entries(mapOf(model.calibration)).map(([id, value]) => {
      const entry = mapOf(value);
      const target = typeof entry.profileId === "string" ? models[entry.profileId] : model;
      if (!target) return [id, unavailablePresentation()];
      const ownEntry = mapOf(mapOf(own.calibration)[id]);
      return [id, projectGeneration({ target, providers, catalog,
        ownGeneration: buildModelGenerationConfig(ownEntry.generation),
        generation: mergeModelGenerationConfig(target.generation as ModelGenerationConfig | undefined, entry.generation as ModelGenerationConfig | undefined),
      })];
    }));
    return { model: projectGeneration({ target: model, generation, ownGeneration, providers, catalog }), calibration };
  } catch {
    return { model: unavailablePresentation(), calibration: {} };
  }
}

/** Presentation projects the same config overlays and resolver without materializing defaults. */
export function buildConfigModelParameterPresentations(snapshot: ConfigDashboardSnapshot, mainConfigPath: string, candidate?: ModelParameterPreviewCandidate): Record<string, ConfigModelParameterPresentation> {
  const runtimeModels = mapOf(snapshot.files.runtime.config.models);
  const declarations = mapOf(runtimeModels.profiles);
  const providers = candidate?.providers ?? mapOf(runtimeModels.providers);
  const draftModels = new Map(candidate?.models.map((model) => [model.id, model]) ?? []);
  const ownModels = Object.fromEntries(snapshot.files.models.map((file) => [file.id, { ...file.config, ...(draftModels.get(file.id) ?? {}) }]));
  const models = Object.fromEntries(snapshot.files.models.map((file) => {
    const own = ownModels[file.id];
    const declaration = mapOf(declarations[file.id]);
    try {
      return [file.id, mergeModelProfileSources(own, typeof declaration.configRef === "string" ? declaration : {})];
    } catch {
      return [file.id, undefined];
    }
  }));
  const catalog = loadModelParameterProfileCatalog({ mainConfigPath });
  const selected = candidate ? snapshot.files.models.filter((file) => file.id === candidate.modelId) : snapshot.files.models;
  return Object.fromEntries(selected.map((file) => [file.id, projectModel(models[file.id], ownModels[file.id], models, providers, catalog)]));
}
