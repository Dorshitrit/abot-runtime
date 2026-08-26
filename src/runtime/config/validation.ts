import {
  PATH_CONFIG_FIELDS,
  STRING_CONFIG_FIELDS,
  TIMEOUT_CONFIG_FIELDS,
} from "./fields.js";
import type { RuntimeConfigFile } from "./types.js";
import { hasOwnValue, isRecord } from "./utils.js";
import {
  isRequestExecutionPolicyId,
  REQUEST_EXECUTION_POLICY_IDS,
} from "./model-execution-policy.js";

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type RuntimeConfigValidationOptions = Readonly<{
  /** Inspection-only mode. Canonical runtime loading always omits this flag. */
  allowIncompleteSetup?: boolean;
}>;

export class RuntimeConfigValidationError extends Error {
  readonly configPath: string;
  readonly issues: string[];

  constructor(configPath: string, issues: string[]) {
    super(
      [
        `Invalid runtime config at ${configPath}:`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
    this.name = "RuntimeConfigValidationError";
    this.configPath = configPath;
    this.issues = issues;
  }
}

function validateOptionalString(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${displayKey} must be a non-empty string`);
  }
}

function validateOptionalSetupString(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey: string,
  allowIncompleteSetup: boolean,
): void {
  const value = record[key];
  if (
    allowIncompleteSetup &&
    hasOwnValue(record, key) &&
    typeof value === "string" &&
    value.trim().length === 0
  ) {
    return;
  }
  validateOptionalString(issues, record, key, displayKey);
}

function validateOptionalEnvVarName(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${displayKey} must be a non-empty string`);
    return;
  }
  if (!ENV_VAR_NAME_PATTERN.test(value.trim())) {
    issues.push(`${displayKey} must be an environment variable name`);
  }
}

function validateOptionalObject(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): Record<string, unknown> | undefined {
  if (!hasOwnValue(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isRecord(value)) {
    issues.push(`${displayKey} must be an object`);
    return undefined;
  }
  return value;
}

function validateOptionalBoolean(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (typeof record[key] !== "boolean") {
    issues.push(`${displayKey} must be a boolean`);
  }
}

function validateOptionalStringArray(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.push(`${displayKey} must be an array of strings`);
  } else if (value.some((entry) => typeof entry !== "string")) {
    issues.push(`${displayKey} must contain only strings`);
  }
}

function validateOptionalModelModalityArray(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.push(`${displayKey} must be an array of model modalities`);
    return;
  }
  for (const entry of value) {
    if (entry !== "text" && entry !== "image" && entry !== "audio") {
      issues.push(`${displayKey} must contain only text, image, or audio`);
      return;
    }
  }
}

function validateOptionalStringMap(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (!isRecord(value)) {
    issues.push(`${displayKey} must be an object`);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string" || entryValue.trim().length === 0) {
      issues.push(`${displayKey}.${entryKey} must be a non-empty string`);
    }
  }
}

function validateContext(
  issues: string[],
  context: Record<string, unknown>,
  displayKey: string,
): void {
  if (hasOwnValue(context, "maxInputTokens")) {
    issues.push(
      `${displayKey}.maxInputTokens is not supported; declare contextWindowTokens on the model profile`,
    );
  }
  if (hasOwnValue(context, "maxConversationMessages")) {
    issues.push(
      `${displayKey}.maxConversationMessages is not supported; current-session history is managed by runtime session memory`,
    );
  }
  if (hasOwnValue(context, "maxToolObservationMessages")) {
    issues.push(
      `${displayKey}.maxToolObservationMessages is not supported; tool observations are projected by their owning context contract`,
    );
  }
  const formatTokenAccounting = validateOptionalObject(
    issues,
    context,
    "formatTokenAccounting",
    `${displayKey}.formatTokenAccounting`,
  );
  if (formatTokenAccounting) {
    if (
      formatTokenAccounting.mode !== "none" &&
      formatTokenAccounting.mode !== "estimate"
    ) {
      issues.push(
        `${displayKey}.formatTokenAccounting.mode must be none or estimate`,
      );
    }
    validateOptionalNonNegativeInteger(
      issues,
      formatTokenAccounting,
      "fixedOverheadTokens",
      `${displayKey}.formatTokenAccounting.fixedOverheadTokens`,
    );
  }
  if (hasOwnValue(context, "artifactContextMode")) {
    issues.push(
      `${displayKey}.artifactContextMode is not supported; artifact projection is owned by the capability context contract`,
    );
  }
  const tokenEstimation = validateOptionalObject(
    issues,
    context,
    "tokenEstimation",
    `${displayKey}.tokenEstimation`,
  );
  if (tokenEstimation) {
    validateOptionalPositiveNumber(
      issues,
      tokenEstimation,
      "asciiCharactersPerToken",
      `${displayKey}.tokenEstimation.asciiCharactersPerToken`,
    );
    validateOptionalPositiveNumber(
      issues,
      tokenEstimation,
      "nonAsciiBytesPerToken",
      `${displayKey}.tokenEstimation.nonAsciiBytesPerToken`,
    );
    validateOptionalPositiveNumber(
      issues,
      tokenEstimation,
      "messageOverheadTokens",
      `${displayKey}.tokenEstimation.messageOverheadTokens`,
    );
  }
  if (hasOwnValue(context, "compaction")) {
    issues.push(
      `${displayKey}.compaction is not supported; context compaction uses the runtime-owned 70 percent trigger`,
    );
  }
}

function validateGeneration(
  issues: string[],
  generation: Record<string, unknown>,
  displayKey: string,
): void {
  if (hasOwnValue(generation, "maxOutputTokens")) {
    issues.push(
      `${displayKey}.maxOutputTokens is not supported; remove it and let the provider enforce physical output capacity`,
    );
  }
  validateOptionalNumber(
    issues,
    generation,
    "temperature",
    `${displayKey}.temperature`,
  );
  validateOptionalNumber(issues, generation, "topP", `${displayKey}.topP`);
  if (
    hasOwnValue(generation, "reasoningEffort") &&
    generation.reasoningEffort !== "none" &&
    generation.reasoningEffort !== "minimal" &&
    generation.reasoningEffort !== "low" &&
    generation.reasoningEffort !== "medium" &&
    generation.reasoningEffort !== "high" &&
    generation.reasoningEffort !== "xhigh"
  ) {
    issues.push(
      `${displayKey}.reasoningEffort must be none, minimal, low, medium, high, or xhigh`,
    );
  }
}

function validateOptionalInvocationProfiles(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey: string,
): void {
  const invocationProfiles = validateOptionalObject(
    issues,
    record,
    key,
    displayKey,
  );
  if (!invocationProfiles) {
    return;
  }
  for (const [profileId, profile] of Object.entries(invocationProfiles)) {
    const profileKey = `${displayKey}.${profileId}`;
    if (!isRecord(profile)) {
      issues.push(`${profileKey} must be an object`);
      continue;
    }
    validateOptionalString(
      issues,
      profile,
      "profileId",
      `${profileKey}.profileId`,
    );
    if (!hasOwnValue(profile, "profileId")) {
      issues.push(`${profileKey}.profileId must be a non-empty string`);
    }
    const generation = validateOptionalObject(
      issues,
      profile,
      "generation",
      `${profileKey}.generation`,
    );
    if (generation) {
      validateGeneration(issues, generation, `${profileKey}.generation`);
    }
    const context = validateOptionalObject(
      issues,
      profile,
      "context",
      `${profileKey}.context`,
    );
    if (context) {
      validateContext(issues, context, `${profileKey}.context`);
    }
    if (
      hasOwnValue(profile, "format") &&
      profile.format !== "json" &&
      !isRecord(profile.format)
    ) {
      issues.push(`${profileKey}.format must be json or an object`);
    }
  }
}

function validateOptionalModelCalibrations(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey: string,
): void {
  const calibrations = validateOptionalObject(issues, record, key, displayKey);
  if (!calibrations) {
    return;
  }
  for (const [slotId, calibration] of Object.entries(calibrations)) {
    const slotKey = `${displayKey}.${slotId}`;
    if (!isRecord(calibration)) {
      issues.push(`${slotKey} must be an object`);
      continue;
    }
    validateOptionalString(issues, calibration, "name", `${slotKey}.name`);
    validateOptionalString(
      issues,
      calibration,
      "description",
      `${slotKey}.description`,
    );
    validateOptionalString(
      issues,
      calibration,
      "profileId",
      `${slotKey}.profileId`,
    );
    validateOptionalPositiveInteger(
      issues,
      calibration,
      "timeoutMs",
      `${slotKey}.timeoutMs`,
    );
    const generation = validateOptionalObject(
      issues,
      calibration,
      "generation",
      `${slotKey}.generation`,
    );
    if (generation) {
      validateGeneration(issues, generation, `${slotKey}.generation`);
    }
    const context = validateOptionalObject(
      issues,
      calibration,
      "context",
      `${slotKey}.context`,
    );
    if (context) {
      validateContext(issues, context, `${slotKey}.context`);
    }
    if (
      hasOwnValue(calibration, "format") &&
      calibration.format !== "json" &&
      !isRecord(calibration.format)
    ) {
      issues.push(`${slotKey}.format must be json or an object`);
    }
    validateOptionalStringArray(
      issues,
      calibration,
      "instructions",
      `${slotKey}.instructions`,
    );
  }
}

function validateOptionalNumber(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
    issues.push(`${displayKey} must be a number`);
  }
}

function validateOptionalPositiveNumber(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push(`${displayKey} must be a positive number`);
  }
}

function validateOptionalPositiveInteger(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isInteger(value)
  ) {
    issues.push(`${displayKey} must be a positive integer`);
  }
}

function validateOptionalNonNegativeInteger(
  issues: string[],
  record: Record<string, unknown>,
  key: string,
  displayKey = key,
): void {
  if (!hasOwnValue(record, key)) {
    return;
  }
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    issues.push(`${displayKey} must be a non-negative integer`);
  }
}

export function validateModelProfileConfig(
  issues: string[],
  profile: Record<string, unknown>,
  displayKey: string,
  options: {
    allowConfigRef: boolean;
    allowIncompleteSetup?: boolean;
  } = { allowConfigRef: true },
): void {
  validateOptionalSetupString(
    issues,
    profile,
    "configRef",
    `${displayKey}.configRef`,
    options.allowIncompleteSetup === true,
  );
  validateOptionalString(issues, profile, "label", `${displayKey}.label`);
  validateOptionalSetupString(
    issues,
    profile,
    "provider",
    `${displayKey}.provider`,
    options.allowIncompleteSetup === true,
  );
  validateOptionalSetupString(
    issues,
    profile,
    "model",
    `${displayKey}.model`,
    options.allowIncompleteSetup === true,
  );
  validateOptionalPositiveInteger(
    issues,
    profile,
    "contextWindowTokens",
    `${displayKey}.contextWindowTokens`,
  );
  if (
    hasOwnValue(profile, "contextWindowTokens") &&
    typeof profile.contextWindowTokens === "number" &&
    !Number.isSafeInteger(profile.contextWindowTokens)
  ) {
    issues.push(`${displayKey}.contextWindowTokens must be a safe integer`);
  }
  if (!options.allowIncompleteSetup) {
    if (options.allowConfigRef) {
      if (
        !hasOwnValue(profile, "model") &&
        !hasOwnValue(profile, "configRef")
      ) {
        issues.push(`${displayKey}.model or configRef must be provided`);
      }
    } else if (!hasOwnValue(profile, "model")) {
      issues.push(`${displayKey}.model must be provided`);
    }
    if (
      (!options.allowConfigRef || !hasOwnValue(profile, "configRef")) &&
      !hasOwnValue(profile, "contextWindowTokens")
    ) {
      issues.push(`${displayKey}.contextWindowTokens must be provided`);
    }
  }
  validateOptionalBoolean(
    issues,
    profile,
    "supportsThinking",
    `${displayKey}.supportsThinking`,
  );
  if (hasOwnValue(profile, "options") && !isRecord(profile.options)) {
    issues.push(`${displayKey}.options must be an object`);
  }
  const capabilities = validateOptionalObject(
    issues,
    profile,
    "capabilities",
    `${displayKey}.capabilities`,
  );
  if (capabilities) {
    validateOptionalModelModalityArray(
      issues,
      capabilities,
      "inputModalities",
      `${displayKey}.capabilities.inputModalities`,
    );
    validateOptionalModelModalityArray(
      issues,
      capabilities,
      "outputModalities",
      `${displayKey}.capabilities.outputModalities`,
    );
  }
  const generation = validateOptionalObject(
    issues,
    profile,
    "generation",
    `${displayKey}.generation`,
  );
  if (generation) {
    validateGeneration(issues, generation, `${displayKey}.generation`);
  }
  const context = validateOptionalObject(
    issues,
    profile,
    "context",
    `${displayKey}.context`,
  );
  if (context) {
    validateContext(issues, context, `${displayKey}.context`);
  }
  const execution = validateOptionalObject(
    issues,
    profile,
    "execution",
    `${displayKey}.execution`,
  );
  if (execution) {
    const keys = Object.keys(execution);
    if (keys.some((key) => key !== "policy")) {
      issues.push(`${displayKey}.execution may contain only: policy`);
    }
    if (
      hasOwnValue(execution, "policy") &&
      !isRequestExecutionPolicyId(execution.policy)
    ) {
      issues.push(
        `${displayKey}.execution.policy must be one of: ${REQUEST_EXECUTION_POLICY_IDS.join(", ")}`,
      );
    }
  }
  validateOptionalModelCalibrations(
    issues,
    profile,
    "calibration",
    `${displayKey}.calibration`,
  );
}

function validatePathConfigRecord(
  issues: string[],
  paths: Record<string, unknown>,
  displayKey: string,
): void {
  for (const field of PATH_CONFIG_FIELDS) {
    validateOptionalString(
      issues,
      paths,
      field.key,
      `${displayKey}.${field.key}`,
    );
  }
}

function validateEnvironmentConfig(
  issues: string[],
  environment: Record<string, unknown>,
): void {
  validateOptionalString(issues, environment, "default", "environment.default");
  const basePaths = validateOptionalObject(
    issues,
    environment,
    "paths",
    "environment.paths",
  );
  if (basePaths) {
    validatePathConfigRecord(issues, basePaths, "environment.paths");
  }
  const profiles = validateOptionalObject(
    issues,
    environment,
    "profiles",
    "environment.profiles",
  );
  if (!profiles) {
    return;
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    if (!isRecord(profile)) {
      issues.push(`environment.profiles.${profileId} must be an object`);
      continue;
    }
    const paths = validateOptionalObject(
      issues,
      profile,
      "paths",
      `environment.profiles.${profileId}.paths`,
    );
    if (paths) {
      validatePathConfigRecord(
        issues,
        paths,
        `environment.profiles.${profileId}.paths`,
      );
    }
  }

  const defaultProfileId =
    typeof environment.default === "string" ? environment.default.trim() : "";
  if (defaultProfileId && !hasOwnValue(profiles, defaultProfileId)) {
    issues.push(
      "environment.default must match a key under environment.profiles",
    );
  }
}

function validateLoggingConfig(
  issues: string[],
  logging: Record<string, unknown>,
): void {
  validateOptionalBoolean(issues, logging, "enabled", "logging.enabled");
  const rotation = validateOptionalObject(
    issues,
    logging,
    "rotation",
    "logging.rotation",
  );
  if (!rotation) {
    return;
  }
  for (const key of ["maxFileSizeMb", "maxFiles", "maxAgeDays"]) {
    validateOptionalPositiveNumber(
      issues,
      rotation,
      key,
      `logging.rotation.${key}`,
    );
  }
}

function validateWebUiConfig(
  issues: string[],
  webUi: Record<string, unknown>,
): void {
  validateOptionalBoolean(
    issues,
    webUi,
    "openOnRuntimeServiceStart",
    "webUi.openOnRuntimeServiceStart",
  );
  for (const key of Object.keys(webUi)) {
    if (key !== "openOnRuntimeServiceStart") {
      issues.push(`webUi.${key} is not a supported configuration field`);
    }
  }
}

function validateWebUiConfigSection(
  issues: string[],
  config: Record<string, unknown>,
): void {
  const webUi = validateOptionalObject(issues, config, "webUi");
  if (webUi) {
    validateWebUiConfig(issues, webUi);
  }
}

export function validateRuntimeWebUiConfig(
  config: RuntimeConfigFile,
  configPath: string,
): void {
  const issues: string[] = [];
  validateWebUiConfigSection(issues, config as Record<string, unknown>);
  if (issues.length > 0) {
    throw new RuntimeConfigValidationError(configPath, issues);
  }
}

function validatePluginConfig(
  issues: string[],
  plugins: Record<string, unknown>,
): void {
  validateOptionalBoolean(issues, plugins, "enabled", "plugins.enabled");
  validateOptionalStringArray(issues, plugins, "allow", "plugins.allow");
  validateOptionalStringArray(issues, plugins, "deny", "plugins.deny");
  for (const key of Object.keys(plugins)) {
    if (key !== "enabled" && key !== "allow" && key !== "deny") {
      issues.push(`plugins.${key} is not a supported configuration field`);
    }
  }
}

function validateModelConfig(
  issues: string[],
  models: Record<string, unknown>,
  options: RuntimeConfigValidationOptions = {},
): void {
  const providers = validateOptionalObject(issues, models, "providers");
  if (providers) {
    if (Object.keys(providers).length === 0 && !options.allowIncompleteSetup) {
      issues.push("models.providers must declare at least one provider");
    }
    for (const [providerId, provider] of Object.entries(providers)) {
      const providerKey = `models.providers.${providerId}`;
      if (providerId.trim().length === 0) {
        issues.push("models.providers keys must be non-empty strings");
      }
      if (!isRecord(provider)) {
        issues.push(`${providerKey} must be an object`);
        continue;
      }
      const providerTypeIsIncomplete =
        options.allowIncompleteSetup === true &&
        (!hasOwnValue(provider, "type") ||
          (typeof provider.type === "string" &&
            provider.type.trim().length === 0));
      if (
        !providerTypeIsIncomplete &&
        (!hasOwnValue(provider, "type") ||
          typeof provider.type !== "string" ||
          !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(provider.type.trim()))
      ) {
        issues.push(
          `${providerKey}.type must be a provider adapter identifier`,
        );
      }
      validateOptionalString(
        issues,
        provider,
        "baseUrl",
        `${providerKey}.baseUrl`,
      );
      validateOptionalEnvVarName(
        issues,
        provider,
        "apiKeyEnv",
        `${providerKey}.apiKeyEnv`,
      );
      validateOptionalString(
        issues,
        provider,
        "keepAlive",
        `${providerKey}.keepAlive`,
      );
      validateOptionalObject(
        issues,
        provider,
        "settings",
        `${providerKey}.settings`,
      );
    }
  } else if (
    !hasOwnValue(models, "providers") &&
    !options.allowIncompleteSetup
  ) {
    issues.push("models.providers must declare at least one provider");
  }

  const profiles = validateOptionalObject(issues, models, "profiles");
  if (profiles) {
    if (Object.keys(profiles).length === 0 && !options.allowIncompleteSetup) {
      issues.push("models.profiles must declare at least one model profile");
    }
    for (const [profileId, profile] of Object.entries(profiles)) {
      if (profileId.trim().length === 0) {
        issues.push("models.profiles keys must be non-empty strings");
      }
      if (!isRecord(profile)) {
        issues.push(`models.profiles.${profileId} must be an object`);
        continue;
      }
      validateModelProfileConfig(
        issues,
        profile,
        `models.profiles.${profileId}`,
        {
          allowConfigRef: true,
          allowIncompleteSetup: options.allowIncompleteSetup,
        },
      );
    }
  } else if (
    !hasOwnValue(models, "profiles") &&
    !options.allowIncompleteSetup
  ) {
    issues.push("models.profiles must declare at least one model profile");
  }

  validateOptionalInvocationProfiles(
    issues,
    models,
    "invocationProfiles",
    "models.invocationProfiles",
  );

  const defaults = validateOptionalObject(issues, models, "defaults");
  if (!defaults) {
    return;
  }
  validateOptionalBoolean(
    issues,
    defaults,
    "overrideClientPreference",
    "models.defaults.overrideClientPreference",
  );
  validateOptionalString(
    issues,
    defaults,
    "profileId",
    "models.defaults.profileId",
  );
  validateOptionalStringMap(issues, defaults, "roles", "models.defaults.roles");
  validateOptionalStringMap(issues, defaults, "steps", "models.defaults.steps");
  const defaultContext = validateOptionalObject(
    issues,
    defaults,
    "context",
    "models.defaults.context",
  );
  if (defaultContext) {
    validateContext(issues, defaultContext, "models.defaults.context");
  }
}

function validateRootRequestRunnerConfig(
  issues: string[],
  requestRunner: Record<string, unknown>,
  options: RuntimeConfigValidationOptions = {},
): void {
  const keys = Object.keys(requestRunner);
  const unsupportedKeys = keys.filter((key) => key !== "configRef");
  if (
    unsupportedKeys.length > 0 ||
    (!options.allowIncompleteSetup && keys.length !== 1)
  ) {
    issues.push("requestRunner must contain exactly: configRef");
  }
  if (!hasOwnValue(requestRunner, "configRef")) {
    if (!options.allowIncompleteSetup) {
      issues.push("requestRunner.configRef is required");
    }
    return;
  }
  validateOptionalSetupString(
    issues,
    requestRunner,
    "configRef",
    "requestRunner.configRef",
    options.allowIncompleteSetup === true,
  );
}

export function validateRuntimeConfigFile(
  config: RuntimeConfigFile,
  configPath: string,
  options: RuntimeConfigValidationOptions = {},
): void {
  const issues: string[] = [];
  const record = config as Record<string, unknown>;
  const supportedRootFields = new Set([
    "agentBridgeUrl",
    "agentBridgeToken",
    "modelGatewayUrl",
    "environment",
    "webUi",
    "paths",
    "logging",
    "timeouts",
    "plugins",
    "models",
    "requestRunner",
    "features",
    "featureFlags",
  ]);
  for (const key of Object.keys(record)) {
    if (!supportedRootFields.has(key)) {
      issues.push(`${key} is not a supported runtime configuration field`);
    }
  }

  for (const field of STRING_CONFIG_FIELDS) {
    validateOptionalString(issues, record, field.path);
  }

  const environment = validateOptionalObject(
    issues,
    record,
    "environment",
    "environment",
  );
  if (environment) {
    validateEnvironmentConfig(issues, environment);
  }

  validateWebUiConfigSection(issues, record);

  const paths = validateOptionalObject(issues, record, "paths");
  if (paths) {
    validatePathConfigRecord(issues, paths, "paths");
  }

  const timeouts = validateOptionalObject(issues, record, "timeouts");
  if (timeouts) {
    for (const field of TIMEOUT_CONFIG_FIELDS) {
      if (!hasOwnValue(timeouts, field.key)) {
        continue;
      }
      const value = timeouts[field.key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        issues.push(`timeouts.${field.key} must be a positive number`);
      }
    }
  }

  const logging = validateOptionalObject(issues, record, "logging");
  if (logging) {
    validateLoggingConfig(issues, logging);
  }

  const plugins = validateOptionalObject(issues, record, "plugins");
  if (plugins) {
    validatePluginConfig(issues, plugins);
  }

  const models = validateOptionalObject(issues, record, "models");
  if (models) {
    validateModelConfig(issues, models, options);
  } else if (!hasOwnValue(record, "models") && !options.allowIncompleteSetup) {
    issues.push("models is required");
  }

  const requestRunner = validateOptionalObject(issues, record, "requestRunner");
  if (requestRunner) {
    validateRootRequestRunnerConfig(issues, requestRunner, options);
  } else if (
    !hasOwnValue(record, "requestRunner") &&
    !options.allowIncompleteSetup
  ) {
    issues.push("requestRunner.configRef is required");
  }

  for (const key of ["features", "featureFlags"]) {
    const flags = validateOptionalObject(issues, record, key);
    if (!flags) {
      continue;
    }
    for (const [flagName, value] of Object.entries(flags)) {
      if (
        typeof value !== "boolean" &&
        typeof value !== "number" &&
        typeof value !== "string"
      ) {
        issues.push(`${key}.${flagName} must be a boolean, number, or string`);
      }
    }
  }

  if (issues.length > 0) {
    throw new RuntimeConfigValidationError(configPath, issues);
  }
}
