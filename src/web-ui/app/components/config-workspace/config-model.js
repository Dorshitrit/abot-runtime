import { textOf } from "../../lib/text-format.js";

export const CONFIG_CATEGORIES = ["memory", "pipeline", "models", "advanced"];

const DEFAULT_MODEL_EXECUTION_POLICY = "supervisor-worker-v1";

export const MODEL_EXECUTION_ROUTES = Object.freeze({
  "supervisor-worker-v1": Object.freeze({
    label: "Supervisor",
    description:
      "Coordinates the request and may answer directly or delegate planning, execution, and review to specialist roles. Tools run through a Worker.",
  }),
  "execution-agent-v1": Object.freeze({
    label: "Execution Agent",
    description:
      "Handles the request end to end and can run tools directly. It may consult a Planner or Auditor while remaining responsible for execution and the final response.",
  }),
});

export function isConfigObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneConfig(value) {
  return JSON.parse(JSON.stringify(isConfigObject(value) ? value : {}));
}

function normalizeConfigForComparison(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeConfigForComparison);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeConfigForComparison(value[key])]),
    );
  }
  return value;
}

export function configValuesEqual(left, right) {
  return (
    JSON.stringify(normalizeConfigForComparison(left)) ===
    JSON.stringify(normalizeConfigForComparison(right))
  );
}

export function rawConfigDraftHasChanges(draft, config) {
  try {
    const parsed = JSON.parse(textOf(draft));
    return !isConfigObject(parsed) || !configValuesEqual(parsed, config);
  } catch {
    return true;
  }
}

export function runtimeConfigGraphChanged(baseline, nextConfig) {
  return !configValuesEqual(
    {
      models: baseline?.models,
      requestRunner: baseline?.requestRunner,
    },
    {
      models: nextConfig?.models,
      requestRunner: nextConfig?.requestRunner,
    },
  );
}

function configDeclaresModelContextWindow(config) {
  return (
    isConfigObject(config) &&
    Object.prototype.hasOwnProperty.call(config, "contextWindowTokens")
  );
}

function modelContextWindowIsPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function modelContextWindowValidationError(config) {
  if (!configDeclaresModelContextWindow(config)) return "";
  return modelContextWindowIsPositiveSafeInteger(config.contextWindowTokens)
    ? ""
    : "Context window must be a positive integer within the safe numeric range before this model can be saved.";
}

export function resolveModelExecutionRoute(policy) {
  const configuredPolicy = textOf(policy).trim();
  const resolvedPolicy = configuredPolicy || DEFAULT_MODEL_EXECUTION_POLICY;
  const route = MODEL_EXECUTION_ROUTES[resolvedPolicy];
  return {
    policy: resolvedPolicy,
    label: route?.label || "Unsupported route",
    description:
      route?.description ||
      `${resolvedPolicy} is not supported by this Runtime. Choose a supported route before saving.`,
    implicit: configuredPolicy.length === 0,
    supported: Boolean(route),
  };
}

export function executionPolicyValueForConfig(selectedPolicy, baselinePolicy) {
  const policy = resolveModelExecutionRoute(selectedPolicy).policy;
  const baselineUsesImplicitDefault =
    textOf(baselinePolicy).trim().length === 0;
  return policy === DEFAULT_MODEL_EXECUTION_POLICY &&
    baselineUsesImplicitDefault
    ? undefined
    : policy;
}

export function formattedConfig(config) {
  return JSON.stringify(isConfigObject(config) ? config : {}, null, 2);
}

export function createConfigWorkspaceModel() {
  const state = {
    configDashboard: null,
    baselinesByKey: new Map(),
    rawDraftsByKey: new Map(),
    savingKeys: new Set(),
    savedKeys: new Set(),
    expandedCalibrationKeys: new Set(),
    selectedConfigModelId: "",
    selectedRawConfigKey: "",
    activeCategory: "memory",
    rawPanelOpen: false,
    loadGeneration: 0,
    loading: false,
    canonicalRefreshInFlight: false,
    externalRuntimeMutationInFlight: false,
    bound: false,
  };

  function configFileKey(file) {
    return `${textOf(file?.kind)}:${textOf(file?.id)}`;
  }

  function configFileEntries() {
    const files = state.configDashboard?.files;
    if (!files) return [];
    return [
      files.runtime,
      files.requestRunner,
      ...(Array.isArray(files.models) ? files.models : []),
    ].filter(Boolean);
  }

  function configFileMatchesIdentity(file, kind, id) {
    return file.kind === kind && (!id || file.id === id);
  }

  function findConfigFile(kind, id = "") {
    return configFileEntries().find((file) =>
      configFileMatchesIdentity(file, kind, id),
    );
  }

  function findConfigFileByKey(key) {
    return configFileEntries().find((file) => configFileKey(file) === key);
  }

  function captureBaselines() {
    state.baselinesByKey.clear();
    state.rawDraftsByKey.clear();
    state.savedKeys.clear();
    for (const file of configFileEntries()) {
      const key = configFileKey(file);
      state.baselinesByKey.set(key, cloneConfig(file.config));
      state.rawDraftsByKey.set(key, formattedConfig(file.config));
    }
  }

  function baselineFor(file) {
    return state.baselinesByKey.get(configFileKey(file));
  }

  function isFileDirty(file) {
    const baseline = baselineFor(file);
    return baseline ? !configValuesEqual(file.config, baseline) : false;
  }

  function rawDraftFor(file) {
    const key = configFileKey(file);
    return state.rawDraftsByKey.has(key)
      ? state.rawDraftsByKey.get(key)
      : formattedConfig(file.config);
  }

  function hasRawDraftChanges(file) {
    return rawConfigDraftHasChanges(rawDraftFor(file), file.config);
  }

  function hasPendingFileChanges(file) {
    return isFileDirty(file) || hasRawDraftChanges(file);
  }

  function dirtyFiles() {
    return configFileEntries().filter(hasPendingFileChanges);
  }

  function hasUnsavedChanges() {
    return dirtyFiles().length > 0;
  }

  function dashboardIsBusy() {
    return (
      state.loading ||
      state.canonicalRefreshInFlight ||
      state.externalRuntimeMutationInFlight
    );
  }

  function getConfigPathValue(config, path) {
    let current = config;
    for (const key of path) {
      if (!current || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  }

  function setConfigPathValue(config, path, value) {
    let current = config;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!current[key] || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key];
    }
    current[path[path.length - 1]] = value;
  }

  function deleteConfigPathValue(config, path) {
    let current = config;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!current?.[key] || typeof current[key] !== "object") return;
      current = current[key];
    }
    delete current[path[path.length - 1]];
  }

  function pruneEmptyExecutionConfig(config) {
    if (
      isConfigObject(config.execution) &&
      Object.keys(config.execution).length === 0
    ) {
      delete config.execution;
    }
  }

  function parseConfigPath(value) {
    try {
      const parsed = JSON.parse(textOf(value));
      return Array.isArray(parsed) ? parsed.map(textOf) : [];
    } catch {
      return [];
    }
  }

  function parseNumericConfigInputValue(input) {
    if (input.value.trim() === "") return undefined;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : undefined;
  }

  function parseConfigInputValue(input, file, path) {
    const type = input.dataset.valueType || "string";
    if (type === "boolean") return input.checked;
    if (type === "number") return parseNumericConfigInputValue(input);
    if (type === "execution-policy") {
      return executionPolicyValueForConfig(
        input.value,
        getConfigPathValue(baselineFor(file), path),
      );
    }
    return input.value;
  }

  function ensureRawSelection(files = configFileEntries()) {
    if (
      !files.some((file) => configFileKey(file) === state.selectedRawConfigKey)
    ) {
      state.selectedRawConfigKey = files[0] ? configFileKey(files[0]) : "";
    }
  }

  function selectedRawConfigFile() {
    return findConfigFileByKey(state.selectedRawConfigKey);
  }

  return {
    state,
    baselineFor,
    captureBaselines,
    configFileEntries,
    configFileKey,
    dashboardIsBusy,
    deleteConfigPathValue,
    dirtyFiles,
    ensureRawSelection,
    findConfigFile,
    findConfigFileByKey,
    getConfigPathValue,
    hasPendingFileChanges,
    hasRawDraftChanges,
    hasUnsavedChanges,
    isFileDirty,
    parseConfigInputValue,
    parseConfigPath,
    pruneEmptyExecutionConfig,
    rawDraftFor,
    selectedRawConfigFile,
    setConfigPathValue,
  };
}
