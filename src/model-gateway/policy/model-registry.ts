import type {
  ModelContextConfig,
  ModelGatewayProfileCapabilities,
  ModelGatewayPolicyConfig,
  ModelGatewayProfileConfig,
  ModelGenerationConfig,
  ModelProfile,
} from "../types.js";

const TEXT_MODEL_CAPABILITIES: Required<ModelGatewayProfileCapabilities> = {
  inputModalities: ["text"],
  outputModalities: ["text"],
};

function normalizeConfiguredProfile(
  profileId: string,
  config: ModelGatewayProfileConfig,
  policy?: ModelGatewayPolicyConfig,
): ModelProfile | undefined {
  const model = config.model.trim();
  if (model.length === 0) {
    return undefined;
  }
  const providerId = config.provider?.trim();
  if (!providerId) {
    return undefined;
  }
  const providerConfig = policy?.providers?.[providerId];
  if (!providerConfig) {
    return undefined;
  }
  const declaredContextWindowTokens = normalizePositiveInteger(
    config.contextWindowTokens,
  );
  if (declaredContextWindowTokens === undefined) {
    return undefined;
  }
  const providerAllocatedContextWindowTokens =
    providerConfig.type === "ollama"
      ? normalizePositiveInteger(config.options?.num_ctx)
      : undefined;
  const contextWindowTokens = Math.min(
    declaredContextWindowTokens,
    providerAllocatedContextWindowTokens ?? declaredContextWindowTokens,
  );
  const context = mergeContextConfig(policy?.defaults?.context, config.context);
  const generation = mergeGenerationConfig(config.generation);
  const capabilities = mergeProfileCapabilities(config.capabilities);
  return {
    id: profileId,
    label: config.label?.trim() || profileId,
    providerId,
    provider: providerConfig.type,
    providerConfig,
    model,
    contextWindowTokens,
    supportsThinking: config.supportsThinking === true,
    options: config.options ?? {},
    generation,
    context,
    capabilities,
    ...(config.calibration ? { calibration: config.calibration } : {}),
  };
}

function normalizeModalities(
  values: unknown,
  fallback: readonly ("text" | "image" | "audio")[],
): ("text" | "image" | "audio")[] {
  if (!Array.isArray(values)) {
    return [...fallback];
  }
  const modalities = values.filter(
    (value): value is "text" | "image" | "audio" =>
      value === "text" || value === "image" || value === "audio",
  );
  return modalities.length > 0 ? [...new Set(modalities)] : [...fallback];
}

function mergeProfileCapabilities(
  config?: ModelGatewayProfileCapabilities,
): Required<ModelGatewayProfileCapabilities> {
  return {
    inputModalities: normalizeModalities(
      config?.inputModalities,
      TEXT_MODEL_CAPABILITIES.inputModalities,
    ),
    outputModalities: normalizeModalities(
      config?.outputModalities,
      TEXT_MODEL_CAPABILITIES.outputModalities,
    ),
  };
}

function mergeGenerationConfig(
  ...configs: Array<ModelGenerationConfig | undefined>
): ModelGenerationConfig {
  return Object.assign({}, ...configs.filter(Boolean));
}

function mergeContextConfig(
  ...configs: Array<ModelContextConfig | undefined>
): ModelContextConfig {
  return Object.assign({}, ...configs.filter(Boolean));
}

function buildProfileMap(
  policy?: ModelGatewayPolicyConfig,
): Record<string, ModelProfile> {
  const profiles: Record<string, ModelProfile> = {};
  for (const [profileId, config] of Object.entries(policy?.profiles ?? {})) {
    const normalized = normalizeConfiguredProfile(profileId, config, policy);
    if (normalized) {
      profiles[profileId] = normalized;
    }
  }
  return profiles;
}

export function getModelProfile(
  profileId: string,
  policy?: ModelGatewayPolicyConfig,
): ModelProfile | undefined {
  return buildProfileMap(policy)[profileId];
}

export function listModelProfiles(
  policy?: ModelGatewayPolicyConfig,
): ModelProfile[] {
  return Object.values(buildProfileMap(policy));
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
    ? value
    : undefined;
}

export function resolveModelContextConfig(params: {
  agentMode?: unknown;
  taskType?: string;
  modelPreference?: unknown;
  modelPolicy?: ModelGatewayPolicyConfig;
}): ModelContextConfig {
  const preferredProfileId = readPreferredProfileId(params.modelPreference);
  const profileId =
    preferredProfileId ?? params.modelPolicy?.defaults?.profileId;
  const profile = profileId
    ? getModelProfile(profileId, params.modelPolicy)
    : undefined;
  const defaults = params.modelPolicy?.defaults?.context ?? {};
  return normalizeContextConfig({
    ...defaults,
    ...(profile?.context ?? {}),
  });
}

function readPreferredProfileId(modelPreference: unknown): string | undefined {
  const isPreferenceObject =
    modelPreference !== null &&
    typeof modelPreference === "object" &&
    !Array.isArray(modelPreference);
  if (!isPreferenceObject) {
    return undefined;
  }
  const profileId = (modelPreference as { profileId?: unknown }).profileId;
  return typeof profileId === "string" ? profileId : undefined;
}

function normalizeFormatTokenAccounting(
  formatTokenAccounting: ModelContextConfig["formatTokenAccounting"],
): ModelContextConfig["formatTokenAccounting"] {
  const hasSupportedMode =
    formatTokenAccounting?.mode === "none" ||
    formatTokenAccounting?.mode === "estimate";
  if (!hasSupportedMode) {
    return undefined;
  }
  const normalizedFixedFormatOverheadTokens = normalizeNonNegativeInteger(
    formatTokenAccounting?.fixedOverheadTokens,
  );
  return {
    mode: formatTokenAccounting.mode,
    ...(normalizedFixedFormatOverheadTokens !== undefined
      ? { fixedOverheadTokens: normalizedFixedFormatOverheadTokens }
      : {}),
  };
}

function normalizeTokenEstimation(
  tokenEstimation: ModelContextConfig["tokenEstimation"],
): ModelContextConfig["tokenEstimation"] {
  if (!tokenEstimation) {
    return undefined;
  }
  const normalized: NonNullable<ModelContextConfig["tokenEstimation"]> = {};
  const asciiCharactersPerToken = normalizePositiveNumber(
    tokenEstimation.asciiCharactersPerToken,
  );
  const nonAsciiBytesPerToken = normalizePositiveNumber(
    tokenEstimation.nonAsciiBytesPerToken,
  );
  const messageOverheadTokens = normalizePositiveNumber(
    tokenEstimation.messageOverheadTokens,
  );
  if (asciiCharactersPerToken !== undefined) {
    normalized.asciiCharactersPerToken = asciiCharactersPerToken;
  }
  if (nonAsciiBytesPerToken !== undefined) {
    normalized.nonAsciiBytesPerToken = nonAsciiBytesPerToken;
  }
  if (messageOverheadTokens !== undefined) {
    normalized.messageOverheadTokens = messageOverheadTokens;
  }
  return normalized;
}

function normalizeContextConfig(
  context: ModelContextConfig,
): ModelContextConfig {
  const normalized: ModelContextConfig = {};
  const formatTokenAccounting = normalizeFormatTokenAccounting(
    context.formatTokenAccounting,
  );
  const tokenEstimation = normalizeTokenEstimation(context.tokenEstimation);

  if (formatTokenAccounting) {
    normalized.formatTokenAccounting = formatTokenAccounting;
  }
  if (tokenEstimation) {
    normalized.tokenEstimation = tokenEstimation;
  }
  return normalized;
}
