import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  RuntimeConfig,
  RuntimeLoggingConfig,
  RuntimeModelConfig,
  RuntimePluginConfig,
  RuntimeTimeouts,
} from "../ports.js";
import type {
  ModelContextConfig,
  ModelFormatTokenAccountingConfig,
  ModelGatewayProfileCapabilities,
  ModelGatewayProfileConfig,
  ModelGatewayProviderConfig,
  ModelGenerationConfig,
  ModelInvocationProfileConfig,
  ModelModality,
  ModelStepCalibrationConfig,
  ModelTokenEstimationConfig,
} from "../../model-gateway/types.js";
import {
  DEFAULT_RUNTIME_LOGGING_ENABLED,
  DEFAULT_RUNTIME_LOG_ROTATION_CONFIG,
} from "./constants.js";
import type { RuntimeConfigFile, RuntimeEnv } from "./types.js";
import type { RuntimeModelExecutionPolicies } from "./model-execution-policy.js";
import { isRequestExecutionPolicyId } from "./model-execution-policy.js";
import {
  RuntimeConfigValidationError,
  validateModelProfileConfig,
} from "./validation.js";
import {
  readConfigPositiveInt,
  isRecord,
  readNestedConfigString,
  readNestedConfigStringArray,
  readOptionalBoolean,
  readOptionalStringMap,
} from "./utils.js";

export function compactTimeouts(
  timeouts: RuntimeTimeouts,
): RuntimeTimeouts | undefined {
  const entries = Object.entries(timeouts).filter(
    ([, value]) => typeof value === "number",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildFeatureFlags(
  config: RuntimeConfigFile,
): RuntimeConfig["featureFlags"] {
  const raw = isRecord(config.featureFlags)
    ? config.featureFlags
    : isRecord(config.features)
      ? config.features
      : undefined;
  if (!raw) {
    return undefined;
  }

  const entries = Object.entries(raw).filter(
    (entry): entry is [string, boolean | number | string] => {
      const value = entry[1];
      return (
        typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string"
      );
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readTraceEnabledOverride(
  env: RuntimeEnv | undefined,
): boolean | undefined {
  const value = env?.LLM_RUNTIME_TRACE?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  return !(value === "0" || value === "false" || value === "off");
}

export function buildLoggingConfig(
  config: RuntimeConfigFile,
  env?: RuntimeEnv,
): RuntimeLoggingConfig {
  const logging = isRecord(config.logging) ? config.logging : undefined;
  const rotation = isRecord(logging?.rotation) ? logging.rotation : undefined;
  return {
    enabled:
      readTraceEnabledOverride(env) ??
      readOptionalBoolean(logging, "enabled") ??
      DEFAULT_RUNTIME_LOGGING_ENABLED,
    rotation: {
      maxFileSizeMb:
        readConfigPositiveInt(rotation, "maxFileSizeMb") ??
        DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxFileSizeMb,
      maxFiles:
        readConfigPositiveInt(rotation, "maxFiles") ??
        DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxFiles,
      maxAgeDays:
        readConfigPositiveInt(rotation, "maxAgeDays") ??
        DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxAgeDays,
    },
  };
}

export function buildPluginConfig(
  config: RuntimeConfigFile,
): RuntimePluginConfig | undefined {
  if (!isRecord(config.plugins)) {
    return undefined;
  }
  const enabled = readOptionalBoolean(config.plugins, "enabled");
  const allow = readNestedConfigStringArray(config.plugins, "allow");
  const deny = readNestedConfigStringArray(config.plugins, "deny");
  const pluginConfig: RuntimePluginConfig = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
  };
  return Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined;
}

function buildModelProfile(
  profile: Record<string, unknown>,
): ModelGatewayProfileConfig | undefined {
  const model = readNestedConfigString(profile, "model");
  if (!model) {
    return undefined;
  }
  const label = readNestedConfigString(profile, "label");
  const provider = readNestedConfigString(profile, "provider");
  const contextWindowTokens = readOptionalPositiveInteger(
    profile,
    "contextWindowTokens",
  );
  const supportsThinking = readOptionalBoolean(profile, "supportsThinking");
  const generation = buildModelGenerationConfig(profile.generation);
  const context = buildModelContextConfig(profile.context);
  const capabilities = buildModelCapabilities(profile.capabilities);
  const calibration = buildModelStepCalibrations(profile.calibration);
  const configRef = readNestedConfigString(profile, "configRef");

  return {
    ...(configRef ? { configRef } : {}),
    ...(label ? { label } : {}),
    ...(provider ? { provider } : {}),
    model,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(supportsThinking !== undefined ? { supportsThinking } : {}),
    ...(isRecord(profile.options) ? { options: profile.options } : {}),
    ...(generation ? { generation } : {}),
    ...(context ? { context } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(calibration ? { calibration } : {}),
  };
}

function mergeRawCalibration(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Array.from(new Set([...Object.keys(base), ...Object.keys(override)])).map(
      (slotId) => {
        const baseSlot = base[slotId];
        const overrideSlot = override[slotId];
        return [
          slotId,
          isRecord(baseSlot) && isRecord(overrideSlot)
            ? mergeModelProfileSources(baseSlot, overrideSlot)
            : (overrideSlot ?? baseSlot),
        ];
      },
    ),
  );
}

function mergeModelProfileSources(
  referenced: Record<string, unknown>,
  inline: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...referenced,
    ...inline,
    ...(isRecord(referenced.options) || isRecord(inline.options)
      ? {
          options: {
            ...(isRecord(referenced.options) ? referenced.options : {}),
            ...(isRecord(inline.options) ? inline.options : {}),
          },
        }
      : {}),
    ...(isRecord(referenced.generation) || isRecord(inline.generation)
      ? {
          generation: {
            ...(isRecord(referenced.generation) ? referenced.generation : {}),
            ...(isRecord(inline.generation) ? inline.generation : {}),
          },
        }
      : {}),
    ...(isRecord(referenced.context) || isRecord(inline.context)
      ? {
          context: {
            ...(isRecord(referenced.context) ? referenced.context : {}),
            ...(isRecord(inline.context) ? inline.context : {}),
          },
        }
      : {}),
    ...(isRecord(referenced.capabilities) || isRecord(inline.capabilities)
      ? {
          capabilities: {
            ...(isRecord(referenced.capabilities)
              ? referenced.capabilities
              : {}),
            ...(isRecord(inline.capabilities) ? inline.capabilities : {}),
          },
        }
      : {}),
    ...(isRecord(referenced.calibration) || isRecord(inline.calibration)
      ? {
          calibration: mergeRawCalibration(
            isRecord(referenced.calibration) ? referenced.calibration : {},
            isRecord(inline.calibration) ? inline.calibration : {},
          ),
        }
      : {}),
  };
}

function buildModelStepCalibrations(
  value: unknown,
): Record<string, ModelStepCalibrationConfig> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries: Array<[string, ModelStepCalibrationConfig]> = [];
  for (const [slotId, calibration] of Object.entries(value)) {
    if (!isRecord(calibration)) {
      continue;
    }
    const profileId = readNestedConfigString(calibration, "profileId");
    const timeoutMs = readConfigPositiveInt(calibration, "timeoutMs");
    const generation = buildModelGenerationConfig(calibration.generation);
    const context = buildModelContextConfig(calibration.context);
    const format = buildModelGatewayFormat(calibration.format);
    const instructions = readNestedConfigStringArray(
      calibration,
      "instructions",
    );
    const config: ModelStepCalibrationConfig = {
      ...(profileId ? { profileId } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(generation ? { generation } : {}),
      ...(context ? { context } : {}),
      ...(format ? { format } : {}),
      ...(instructions ? { instructions } : {}),
    };
    if (Object.keys(config).length > 0) {
      entries.push([slotId, config]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveModelProfileRefPath(params: {
  mainConfigPath: string;
  configRef: string;
}): string {
  return isAbsolute(params.configRef)
    ? params.configRef
    : resolve(dirname(params.mainConfigPath), params.configRef);
}

function readReferencedModelProfileConfig(params: {
  mainConfigPath: string;
  configRef: string;
}): Record<string, unknown> {
  const referencedPath = resolveModelProfileRefPath(params);
  let raw = "";
  try {
    raw = readFileSync(referencedPath, "utf-8");
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      throw new RuntimeConfigValidationError(referencedPath, [
        "model profile configRef file was not found",
      ]);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid model profile config JSON at ${referencedPath}: ${message}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new RuntimeConfigValidationError(referencedPath, [
      "root must be an object",
    ]);
  }
  const issues: string[] = [];
  validateModelProfileConfig(issues, parsed, "model profile", {
    allowConfigRef: false,
  });
  if (issues.length > 0) {
    throw new RuntimeConfigValidationError(referencedPath, issues);
  }
  return parsed;
}

export function buildModelGatewayFormat(
  value: unknown,
): "json" | Record<string, unknown> | undefined {
  if (value === "json") {
    return "json";
  }
  return isRecord(value) ? value : undefined;
}

function buildModelInvocationProfile(
  profile: Record<string, unknown>,
): ModelInvocationProfileConfig | undefined {
  const profileId = readNestedConfigString(profile, "profileId");
  if (!profileId) {
    return undefined;
  }
  const generation = buildModelGenerationConfig(profile.generation);
  const context = buildModelContextConfig(profile.context);
  const format = buildModelGatewayFormat(profile.format);

  return {
    profileId,
    ...(generation ? { generation } : {}),
    ...(context ? { context } : {}),
    ...(format ? { format } : {}),
  };
}

function readModelModalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const modalities = value.filter(
    (entry): entry is ModelModality =>
      entry === "text" || entry === "image" || entry === "audio",
  );
  return modalities.length > 0 ? [...new Set(modalities)] : undefined;
}

function buildModelCapabilities(
  value: unknown,
): ModelGatewayProfileCapabilities | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputModalities = readModelModalities(value.inputModalities);
  const outputModalities = readModelModalities(value.outputModalities);
  const capabilities: ModelGatewayProfileCapabilities = {
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
  };
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readOptionalNumber(record, key);
  return value !== undefined && value > 0 && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function readOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readOptionalNumber(record, key);
  return value !== undefined && value >= 0 && Number.isInteger(value)
    ? value
    : undefined;
}

function readOptionalPositiveNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readOptionalNumber(record, key);
  return value !== undefined && value > 0 ? value : undefined;
}

function buildModelTokenEstimationConfig(
  value: unknown,
): ModelTokenEstimationConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const asciiCharactersPerToken = readOptionalPositiveNumber(
    value,
    "asciiCharactersPerToken",
  );
  const nonAsciiBytesPerToken = readOptionalPositiveNumber(
    value,
    "nonAsciiBytesPerToken",
  );
  const messageOverheadTokens = readOptionalPositiveNumber(
    value,
    "messageOverheadTokens",
  );
  const config: ModelTokenEstimationConfig = {
    ...(asciiCharactersPerToken !== undefined
      ? { asciiCharactersPerToken }
      : {}),
    ...(nonAsciiBytesPerToken !== undefined ? { nonAsciiBytesPerToken } : {}),
    ...(messageOverheadTokens !== undefined ? { messageOverheadTokens } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

function buildModelFormatTokenAccountingConfig(
  value: unknown,
): ModelFormatTokenAccountingConfig | undefined {
  if (
    !isRecord(value) ||
    (value.mode !== "none" && value.mode !== "estimate")
  ) {
    return undefined;
  }
  const fixedOverheadTokens = readOptionalNonNegativeInteger(
    value,
    "fixedOverheadTokens",
  );
  return {
    mode: value.mode,
    ...(fixedOverheadTokens !== undefined ? { fixedOverheadTokens } : {}),
  };
}

export function buildModelGenerationConfig(
  value: unknown,
): ModelGenerationConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const temperature = readOptionalNumber(value, "temperature");
  const topP = readOptionalNumber(value, "topP");
  const reasoningEffort =
    value.reasoningEffort === "none" ||
    value.reasoningEffort === "minimal" ||
    value.reasoningEffort === "low" ||
    value.reasoningEffort === "medium" ||
    value.reasoningEffort === "high" ||
    value.reasoningEffort === "xhigh"
      ? value.reasoningEffort
      : undefined;
  const config: ModelGenerationConfig = {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function buildModelContextConfig(
  value: unknown,
): ModelContextConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const formatTokenAccounting = buildModelFormatTokenAccountingConfig(
    value.formatTokenAccounting,
  );
  const tokenEstimation = buildModelTokenEstimationConfig(
    value.tokenEstimation,
  );
  const config: ModelContextConfig = {
    ...(formatTokenAccounting ? { formatTokenAccounting } : {}),
    ...(tokenEstimation ? { tokenEstimation } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

function buildModelProvider(
  provider: Record<string, unknown>,
): ModelGatewayProviderConfig | undefined {
  const type = readNestedConfigString(provider, "type");
  if (!type) {
    return undefined;
  }
  const baseUrl = readNestedConfigString(provider, "baseUrl");
  const apiKeyEnv = readNestedConfigString(provider, "apiKeyEnv");
  const keepAlive = readNestedConfigString(provider, "keepAlive");
  const settings = isRecord(provider.settings)
    ? { ...provider.settings }
    : undefined;
  return {
    type,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(keepAlive ? { keepAlive } : {}),
    ...(settings ? { settings } : {}),
  };
}

function buildModelProviders(
  providers: unknown,
): RuntimeModelConfig["providers"] | undefined {
  if (!isRecord(providers)) {
    return undefined;
  }
  const entries: Array<[string, ModelGatewayProviderConfig]> = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    const modelProvider = buildModelProvider(provider);
    if (modelProvider) {
      entries.push([providerId, modelProvider]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildModelProfiles(
  profiles: unknown,
  options?: { mainConfigPath?: string },
): Readonly<{
  gatewayProfiles?: RuntimeModelConfig["profiles"];
  executionPolicies?: RuntimeModelExecutionPolicies;
}> {
  if (!isRecord(profiles)) {
    return {};
  }
  const gatewayEntries: Array<[string, ModelGatewayProfileConfig]> = [];
  const executionEntries: Array<
    [string, RuntimeModelExecutionPolicies[string]]
  > = [];
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (!isRecord(profile)) {
      continue;
    }
    const configRef = readNestedConfigString(profile, "configRef");
    const referenced =
      configRef && options?.mainConfigPath
        ? readReferencedModelProfileConfig({
            mainConfigPath: options.mainConfigPath,
            configRef,
          })
        : undefined;
    const source = referenced
      ? mergeModelProfileSources(referenced, profile)
      : profile;
    const modelProfile = buildModelProfile(source);
    if (!modelProfile && configRef) {
      throw new RuntimeConfigValidationError(
        options?.mainConfigPath ?? "runtime config",
        [`models.profiles.${profileId}.model must be a non-empty string`],
      );
    }
    if (modelProfile) {
      gatewayEntries.push([profileId, modelProfile]);
    }
    const execution = isRecord(source.execution) ? source.execution : undefined;
    if (execution && isRequestExecutionPolicyId(execution.policy)) {
      executionEntries.push([profileId, { policy: execution.policy }]);
    }
  }
  return {
    ...(gatewayEntries.length > 0
      ? { gatewayProfiles: Object.fromEntries(gatewayEntries) }
      : {}),
    ...(executionEntries.length > 0
      ? { executionPolicies: Object.fromEntries(executionEntries) }
      : {}),
  };
}

export function buildModelInvocationProfiles(
  profiles: unknown,
): RuntimeModelConfig["invocationProfiles"] | undefined {
  if (!isRecord(profiles)) {
    return undefined;
  }
  const entries: Array<[string, ModelInvocationProfileConfig]> = [];
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (!isRecord(profile)) {
      continue;
    }
    const invocationProfile = buildModelInvocationProfile(profile);
    if (invocationProfile) {
      entries.push([profileId, invocationProfile]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildModelDefaults(
  defaults: unknown,
): RuntimeModelConfig["defaults"] | undefined {
  if (!isRecord(defaults)) {
    return undefined;
  }
  const overrideClientPreference = readOptionalBoolean(
    defaults,
    "overrideClientPreference",
  );
  const profileId = readNestedConfigString(defaults, "profileId");
  const roles = readOptionalStringMap(defaults, "roles");
  const steps = readOptionalStringMap(defaults, "steps");
  const context = buildModelContextConfig(defaults.context);
  const config: RuntimeModelConfig["defaults"] = {
    ...(overrideClientPreference !== undefined
      ? { overrideClientPreference }
      : {}),
    ...(profileId ? { profileId } : {}),
    ...(roles ? { roles } : {}),
    ...(steps ? { steps } : {}),
    ...(context ? { context } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export type BuiltRuntimeModelConfiguration = Readonly<{
  modelPolicy?: RuntimeModelConfig;
  executionPolicies?: RuntimeModelExecutionPolicies;
}>;

export function buildRuntimeModelConfiguration(
  config: RuntimeConfigFile,
  options?: { mainConfigPath?: string },
): BuiltRuntimeModelConfiguration {
  if (!isRecord(config.models)) {
    return {};
  }
  const providers = buildModelProviders(config.models.providers);
  const builtProfiles = buildModelProfiles(config.models.profiles, options);
  const invocationProfiles = buildModelInvocationProfiles(
    config.models.invocationProfiles,
  );
  const defaults = buildModelDefaults(config.models.defaults);
  const modelPolicy =
    providers || builtProfiles.gatewayProfiles || invocationProfiles || defaults
      ? {
          ...(providers ? { providers } : {}),
          ...(builtProfiles.gatewayProfiles
            ? { profiles: builtProfiles.gatewayProfiles }
            : {}),
          ...(invocationProfiles ? { invocationProfiles } : {}),
          ...(defaults ? { defaults } : {}),
        }
      : undefined;
  return {
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(builtProfiles.executionPolicies
      ? { executionPolicies: builtProfiles.executionPolicies }
      : {}),
  };
}

export function buildModelConfig(
  config: RuntimeConfigFile,
  options?: { mainConfigPath?: string },
): RuntimeModelConfig | undefined {
  return buildRuntimeModelConfiguration(config, options).modelPolicy;
}
