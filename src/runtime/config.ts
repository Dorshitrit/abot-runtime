import { join } from "node:path";

import {
  DEFAULT_RUNTIME_ID,
  DEFAULT_MODEL_GATEWAY_URL,
} from "../shared/constants.js";
import { loadDotEnvFile } from "../shared/load-dotenv.js";
import {
  buildFeatureFlags,
  buildLoggingConfig,
  buildRuntimeModelConfiguration,
  buildPluginConfig,
  compactTimeouts,
} from "./config/builders.js";
import { buildLongTermMemoryConfig } from "./config/long-term-memory.js";
import {
  DEFAULT_RUNTIME_AGENT_BRIDGE_URL,
  DEFAULT_RUNTIME_CONFIG_FILE,
} from "./config/constants.js";
import { validateEffectiveRuntimeModelConfig } from "./config/effective-model-config-validation.js";
import { resolveRuntimeEnvironmentProfileSelection } from "./config/environment.js";
import { RUNTIME_CONFIG_SCHEMA_FIELDS } from "./config/fields.js";
import { loadRuntimeConfigFileWithMeta } from "./config/loader.js";
import { resolveRequestRunnerConfigReference } from "./config/request-runner-config.js";
import { loadRequestRunnerConfig } from "./config/runner/loader.js";
import {
  DEFAULT_RUNTIME_COMPILED_DIR,
  DEFAULT_RUNTIME_SHARED_DIR,
  DEFAULT_AGENT_WORK_DIR,
  DEFAULT_RUNTIME_STATE_DIR,
  DEFAULT_WORKSPACE_SOURCE_DIR,
  RUNTIME_ATTACHMENTS_DIR_NAME,
  RUNTIME_LOGS_DIR_NAME,
  RUNTIME_SESSIONS_DIR_NAME,
} from "./config/layout.js";
import {
  createRuntimeConfigJsonSchema,
  RUNTIME_CONFIG_JSON_SCHEMA,
} from "./config/schema.js";
import type {
  RuntimeConfigJsonSchema,
  RuntimeConfigOptions,
  RuntimeConfigSchemaField,
} from "./config/types.js";
import {
  readConfigPositiveInt,
  readConfigString,
  readFirstString,
  readNestedConfigString,
  readPositiveInt,
  resolveRuntimePath,
} from "./config/utils.js";
import { RuntimeConfigValidationError } from "./config/validation.js";
import type { RuntimeConfig } from "./ports.js";

export {
  DEFAULT_RUNTIME_AGENT_BRIDGE_URL,
  DEFAULT_RUNTIME_CONFIG_FILE,
  RUNTIME_CONFIG_JSON_SCHEMA,
  RUNTIME_CONFIG_SCHEMA_FIELDS,
  RuntimeConfigValidationError,
  createRuntimeConfigJsonSchema,
};
export type {
  RuntimeConfigJsonSchema,
  RuntimeConfigOptions,
  RuntimeConfigSchemaField,
};

function resolveRuntimeStatePath(params: {
  env: RuntimeConfigOptions["env"];
  envNames: readonly string[];
  profilePaths?: Record<string, unknown>;
  basePaths: unknown;
  key: string;
  rootDir: string;
  runtimeDir: string;
  fallback: string;
  selectedProfile: boolean;
}): string {
  const envValue = readFirstString(params.env ?? {}, params.envNames);
  if (envValue) {
    return resolveRuntimePath(params.rootDir, envValue);
  }
  const profileValue = readNestedConfigString(params.profilePaths, params.key);
  if (profileValue) {
    return resolveRuntimePath(params.rootDir, profileValue);
  }
  if (params.selectedProfile) {
    return resolveRuntimePath(params.rootDir, params.fallback);
  }
  const baseValue = readNestedConfigString(params.basePaths, params.key);
  return resolveRuntimePath(params.rootDir, baseValue ?? params.fallback);
}

export function loadRuntimeConfig(
  options: RuntimeConfigOptions = {},
): RuntimeConfig {
  const rootDir = options.rootDir ?? process.cwd();
  if (!options.env) {
    loadDotEnvFile(options.envPath ?? join(rootDir, ".env"));
  }

  const env = options.env ?? process.env;
  const configPath =
    options.configPath ?? readFirstString(env, ["LLM_RUNTIME_CONFIG_FILE"]);
  const loadedConfig = loadRuntimeConfigFileWithMeta(rootDir, configPath);
  const fileConfig = loadedConfig.config;
  const requestRunner = resolveRequestRunnerConfigReference({
    fileConfig,
    mainConfigPath: loadedConfig.path,
  });
  if (!requestRunner) {
    throw new RuntimeConfigValidationError(loadedConfig.path, [
      "requestRunner.configRef is required",
    ]);
  }
  const profileSelection = resolveRuntimeEnvironmentProfileSelection({
    config: fileConfig,
    env,
    profileId: options.profileId,
  });
  const basePaths = profileSelection.basePaths ?? fileConfig.paths;
  const runtimeDir = resolveRuntimePath(
    rootDir,
    readFirstString(env, ["LLM_RUNTIME_DIR"]) ??
      readNestedConfigString(profileSelection.profilePaths, "runtimeDir") ??
      readNestedConfigString(basePaths, "runtimeDir") ??
      DEFAULT_RUNTIME_STATE_DIR,
  );
  const agentWorkDir = resolveRuntimePath(
    rootDir,
    readFirstString(env, ["LLM_RUNTIME_AGENT_WORK_DIR"]) ??
      readNestedConfigString(profileSelection.profilePaths, "agentWorkDir") ??
      readNestedConfigString(basePaths, "agentWorkDir") ??
      DEFAULT_AGENT_WORK_DIR,
  );
  const compiledDir = resolveRuntimePath(
    rootDir,
    readFirstString(env, ["LLM_RUNTIME_COMPILED_DIR"]) ??
      readNestedConfigString(profileSelection.profilePaths, "compiledDir") ??
      readNestedConfigString(basePaths, "compiledDir") ??
      DEFAULT_RUNTIME_COMPILED_DIR,
  );
  const sharedDir = resolveRuntimePath(
    rootDir,
    readFirstString(env, ["LLM_RUNTIME_SHARED_DIR"]) ??
      readNestedConfigString(profileSelection.profilePaths, "sharedDir") ??
      readNestedConfigString(basePaths, "sharedDir") ??
      DEFAULT_RUNTIME_SHARED_DIR,
  );
  const traceFile = resolveRuntimeStatePath({
    env,
    envNames: ["LLM_RUNTIME_TRACE_FILE"],
    profilePaths: profileSelection.profilePaths,
    basePaths,
    key: "traceFile",
    rootDir,
    runtimeDir,
    fallback: join(runtimeDir, RUNTIME_LOGS_DIR_NAME, "runtime-debug.jsonl"),
    selectedProfile: !!profileSelection.profileId,
  });

  const timeouts = compactTimeouts({
    requestTimeoutMs:
      readPositiveInt(env, "LLM_RUNTIME_REQUEST_TIMEOUT_MS") ??
      readConfigPositiveInt(fileConfig.timeouts, "requestTimeoutMs"),
    requestInactivityTimeoutMs:
      readPositiveInt(env, "LLM_RUNTIME_REQUEST_INACTIVITY_TIMEOUT_MS") ??
      readConfigPositiveInt(fileConfig.timeouts, "requestInactivityTimeoutMs"),
    modelStepTimeoutMs:
      readPositiveInt(env, "LLM_RUNTIME_MODEL_STEP_TIMEOUT_MS") ??
      readConfigPositiveInt(fileConfig.timeouts, "modelStepTimeoutMs"),
    streamInactivityTimeoutMs:
      readPositiveInt(env, "LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS") ??
      readConfigPositiveInt(fileConfig.timeouts, "streamInactivityTimeoutMs"),
  });
  const featureFlags = buildFeatureFlags(fileConfig);
  const pluginConfig = buildPluginConfig(fileConfig);
  const modelConfiguration = buildRuntimeModelConfiguration(fileConfig, {
    mainConfigPath: loadedConfig.path,
  });
  validateEffectiveRuntimeModelConfig({
    configPath: loadedConfig.path,
    modelPolicy: modelConfiguration.modelPolicy,
    runnerConfig: loadRequestRunnerConfig({
      configPath: requestRunner.configPath,
    }),
  });
  const loggingConfig = buildLoggingConfig(fileConfig, env);
  const longTermMemory = buildLongTermMemoryConfig(fileConfig);
  const agentBridgeToken =
    readFirstString(env, ["AGENT_BRIDGE_TOKEN"]) ??
    readConfigString(fileConfig, "agentBridgeToken");

  return {
    runtimeId: profileSelection.profileId ?? DEFAULT_RUNTIME_ID,
    agentBridgeUrl:
      readFirstString(env, ["AGENT_BRIDGE_URL"]) ??
      readConfigString(fileConfig, "agentBridgeUrl") ??
      options.defaultAgentBridgeUrl ??
      DEFAULT_RUNTIME_AGENT_BRIDGE_URL,
    ...(agentBridgeToken ? { agentBridgeToken } : {}),
    modelGatewayUrl:
      readFirstString(env, ["MODEL_GATEWAY_URL", "SIMPLE_LLM_SERVER_URL"]) ??
      readConfigString(fileConfig, "modelGatewayUrl") ??
      DEFAULT_MODEL_GATEWAY_URL,
    paths: {
      rootDir,
      runtimeDir,
      agentWorkDir,
      sessionsDir: resolveRuntimeStatePath({
        env,
        envNames: ["LLM_RUNTIME_SESSIONS_DIR"],
        profilePaths: profileSelection.profilePaths,
        basePaths,
        key: "sessionsDir",
        rootDir,
        runtimeDir,
        fallback: join(runtimeDir, RUNTIME_SESSIONS_DIR_NAME),
        selectedProfile: !!profileSelection.profileId,
      }),
      attachmentsDir: resolveRuntimeStatePath({
        env,
        envNames: ["LLM_RUNTIME_ATTACHMENTS_DIR"],
        profilePaths: profileSelection.profilePaths,
        basePaths,
        key: "attachmentsDir",
        rootDir,
        runtimeDir,
        fallback: join(runtimeDir, RUNTIME_ATTACHMENTS_DIR_NAME),
        selectedProfile: !!profileSelection.profileId,
      }),
      workspaceDir:
        readFirstString(env, ["LLM_RUNTIME_WORKSPACE_DIR"]) ??
        resolveRuntimePath(
          rootDir,
          readNestedConfigString(
            profileSelection.profilePaths,
            "workspaceDir",
          ) ??
            readNestedConfigString(basePaths, "workspaceDir") ??
            DEFAULT_WORKSPACE_SOURCE_DIR,
        ),
      sharedDir,
      compiledDir,
      traceFile,
    },
    logging: loggingConfig,
    ...(timeouts ? { timeouts } : {}),
    ...(pluginConfig ? { plugins: pluginConfig } : {}),
    longTermMemory,
    ...(modelConfiguration.modelPolicy
      ? { models: modelConfiguration.modelPolicy }
      : {}),
    ...(modelConfiguration.executionPolicies
      ? { modelExecutionPolicies: modelConfiguration.executionPolicies }
      : {}),
    requestRunner,
    ...(featureFlags ? { featureFlags } : {}),
  };
}

export const loadRuntimeConfigFromEnv = loadRuntimeConfig;
export const createDefaultRuntimeConfig = loadRuntimeConfig;
