import { DEFAULT_MEMORY_RECALL_CALL_LIMIT } from "../long-term-memory/recall-policy.js";
import { DEFAULT_MODEL_GATEWAY_URL } from "../../shared/constants.js";
import {
  DEFAULT_RUNTIME_AGENT_BRIDGE_URL,
  DEFAULT_RUNTIME_LOGGING_ENABLED,
  DEFAULT_RUNTIME_LOG_ROTATION_CONFIG,
} from "./constants.js";
import {
  DEFAULT_AGENT_WORK_DIR,
  DEFAULT_RUNTIME_COMPILED_DIR,
  DEFAULT_RUNTIME_ATTACHMENTS_DIR,
  DEFAULT_RUNTIME_SESSIONS_DIR,
  DEFAULT_RUNTIME_SHARED_DIR,
  DEFAULT_RUNTIME_STATE_DIR,
  DEFAULT_RUNTIME_TRACE_FILE,
  DEFAULT_WORKSPACE_SOURCE_DIR,
} from "./layout.js";
import type {
  PathConfigField,
  RuntimeConfigSchemaField,
  StringConfigField,
  TimeoutConfigField,
} from "./types.js";

export const STRING_CONFIG_FIELDS: readonly StringConfigField[] = [
  {
    path: "agentBridgeUrl",
    env: ["AGENT_BRIDGE_URL"],
    defaultValue: DEFAULT_RUNTIME_AGENT_BRIDGE_URL,
    description: "WebSocket bridge URL used by the default runtime host.",
  },
  {
    path: "agentBridgeToken",
    env: ["AGENT_BRIDGE_TOKEN"],
    description: "Optional bridge authentication token.",
  },
  {
    path: "modelGatewayUrl",
    env: ["MODEL_GATEWAY_URL", "SIMPLE_LLM_SERVER_URL"],
    defaultValue: DEFAULT_MODEL_GATEWAY_URL,
    description: "Base URL for model gateway requests.",
  },
] as const;

export const PATH_CONFIG_FIELDS: readonly PathConfigField[] = [
  {
    key: "runtimeDir",
    env: ["LLM_RUNTIME_DIR"],
    defaultValue: DEFAULT_RUNTIME_STATE_DIR,
    description:
      "Directory for generated runtime state such as sessions and logs.",
  },
  {
    key: "agentWorkDir",
    env: ["LLM_RUNTIME_AGENT_WORK_DIR"],
    defaultValue: DEFAULT_AGENT_WORK_DIR,
    description:
      "Primary directory used by plugins for generated and modified work artifacts.",
  },
  {
    key: "sessionsDir",
    env: ["LLM_RUNTIME_SESSIONS_DIR"],
    defaultValue: DEFAULT_RUNTIME_SESSIONS_DIR,
    description: "Directory used by the default file-backed session store.",
  },
  {
    key: "attachmentsDir",
    env: ["LLM_RUNTIME_ATTACHMENTS_DIR"],
    defaultValue: DEFAULT_RUNTIME_ATTACHMENTS_DIR,
    description: "Directory used by the default file-backed attachment store.",
  },
  {
    key: "workspaceDir",
    env: ["LLM_RUNTIME_WORKSPACE_DIR"],
    defaultValue: DEFAULT_WORKSPACE_SOURCE_DIR,
    description: "Directory containing workspace context source files.",
  },
  {
    key: "sharedDir",
    env: ["LLM_RUNTIME_SHARED_DIR"],
    defaultValue: DEFAULT_RUNTIME_SHARED_DIR,
    description:
      "Directory for generated runtime state shared across environment profiles, such as shared service logs.",
  },
  {
    key: "compiledDir",
    env: ["LLM_RUNTIME_COMPILED_DIR"],
    defaultValue: DEFAULT_RUNTIME_COMPILED_DIR,
    description:
      "Directory containing optional shared generated context artifacts such as file-provider skill manifests.",
  },
  {
    key: "traceFile",
    env: ["LLM_RUNTIME_TRACE_FILE"],
    defaultValue: DEFAULT_RUNTIME_TRACE_FILE,
    description: "JSONL trace file used by runtime observability.",
  },
] as const;

export const TIMEOUT_CONFIG_FIELDS: readonly TimeoutConfigField[] = [
  {
    key: "requestTimeoutMs",
    env: "LLM_RUNTIME_REQUEST_TIMEOUT_MS",
    description: "Optional total request timeout in milliseconds.",
  },
  {
    key: "requestInactivityTimeoutMs",
    env: "LLM_RUNTIME_REQUEST_INACTIVITY_TIMEOUT_MS",
    description: "Optional request inactivity timeout in milliseconds.",
  },
  {
    key: "modelStepTimeoutMs",
    env: "LLM_RUNTIME_MODEL_STEP_TIMEOUT_MS",
    description: "Optional model-step timeout in milliseconds.",
  },
  {
    key: "streamInactivityTimeoutMs",
    env: "LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS",
    description: "Optional model stream inactivity timeout in milliseconds.",
  },
] as const;

export const RUNTIME_CONFIG_SCHEMA_FIELDS: readonly RuntimeConfigSchemaField[] =
  [
    ...STRING_CONFIG_FIELDS.map((field) => ({
      path: field.path,
      type: "non-empty-string" as const,
      env: field.env,
      ...(field.defaultValue ? { defaultValue: field.defaultValue } : {}),
      description: field.description,
    })),
    {
      path: "environment.default",
      type: "non-empty-string",
      env: ["LLM_RUNTIME_PROFILE"],
      description:
        "Default runtime environment profile id selected when no explicit profile override is provided.",
    },
    {
      path: "environment.paths",
      type: "object-map",
      description:
        "Base filesystem paths shared by runtime environment profiles before profile-specific path overrides are applied.",
    },
    ...PATH_CONFIG_FIELDS.map((field) => ({
      path: `environment.paths.${field.key}`,
      type: "non-empty-string" as const,
      env: field.env,
      defaultValue: field.defaultValue,
      description: field.description,
    })),
    {
      path: "environment.profiles",
      type: "object-map",
      description:
        "Named runtime environment profiles that override filesystem paths for isolated runtime data roots.",
    },
    ...PATH_CONFIG_FIELDS.map((field) => ({
      path: `paths.${field.key}`,
      type: "non-empty-string" as const,
      env: field.env,
      defaultValue: field.defaultValue,
      description: field.description,
    })),
    ...TIMEOUT_CONFIG_FIELDS.map((field) => ({
      path: `timeouts.${field.key}`,
      type: "positive-number" as const,
      env: [field.env],
      description: field.description,
    })),
    {
      path: "webUi.openOnRuntimeServiceStart",
      type: "boolean",
      defaultValue: "false",
      description:
        "Whether the local Web UI should open automatically when the Runtime service starts.",
    },
    {
      path: "logging.enabled",
      type: "boolean",
      defaultValue: String(DEFAULT_RUNTIME_LOGGING_ENABLED),
      description:
        "Whether runtime observability writes the active JSONL trace file.",
    },
    {
      path: "logging.rotation.maxFileSizeMb",
      type: "positive-number",
      defaultValue: String(DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxFileSizeMb),
      description:
        "Rotate the active JSONL trace file when it reaches this size in megabytes.",
    },
    {
      path: "logging.rotation.maxFiles",
      type: "positive-number",
      defaultValue: String(DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxFiles),
      description:
        "Maximum number of rotated JSONL trace siblings retained beside the active file.",
    },
    {
      path: "logging.rotation.maxAgeDays",
      type: "positive-number",
      defaultValue: String(DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxAgeDays),
      description:
        "Maximum age in days for rotated JSONL trace siblings before cleanup removes them.",
    },
    {
      path: "plugins.enabled",
      type: "boolean",
      defaultValue: "true",
      description: "Whether installed runtime plugins are allowed to load.",
    },
    {
      path: "plugins.allow",
      type: "string-array",
      defaultValue: '["*"]',
      description:
        "Optional allow-list of installed plugin or capability ids. The wildcard enables every installed plugin.",
    },
    {
      path: "plugins.deny",
      type: "string-array",
      defaultValue: "[]",
      description:
        "Installed plugin or capability ids denied after applying the allow-list.",
    },
    {
      path: "models.providers",
      type: "object-map",
      description:
        "Model provider declarations keyed by provider id. Profiles reference these ids.",
    },
    {
      path: "models.profiles",
      type: "object-map",
      description:
        "Host-defined model profiles keyed by profile id for model-gateway policy.",
    },
    {
      path: "models.embeddingProfiles",
      type: "object-map",
      description:
        "Provider and model bindings for non-generative embedding operations.",
    },
    {
      path: "models.profiles.<profileId>.configRef",
      type: "non-empty-string",
      description:
        "Optional path to a model profile config file, resolved relative to the runtime config file.",
    },
    {
      path: "models.profiles.<profileId>.calibration",
      type: "object-map",
      description:
        "Per-model calibration slots keyed by semantic slot id. Runtime step config maps modelStep names to these slot ids. Slots may tune timeout, generation, context, format, and short model-specific instructions.",
    },
    {
      path: "models.profiles.<profileId>.execution.policy",
      type: "non-empty-string",
      defaultValue: "supervisor-worker-v1",
      description:
        "Optional runtime-only request execution policy for this model profile. Omission selects supervisor-worker-v1; execution-agent-v1 is an explicit per-profile opt-in. The field is not forwarded to the model gateway.",
    },
    {
      path: "models.invocationProfiles",
      type: "object-map",
      description:
        "Invocation profiles keyed by id. Entries reference a model profile and override per-invocation generation, context, or format policy.",
    },
    {
      path: "models.defaults.overrideClientPreference",
      type: "boolean",
      defaultValue: "false",
      description:
        "Whether runtime model selection ignores the client-selected model globally.",
    },
    {
      path: "models.defaults.profileId",
      type: "non-empty-string",
      description: "Default model profile id for ordinary runtime model calls.",
    },
    {
      path: "models.defaults.roles",
      type: "string-map",
      description: "Default model profile ids by runtime role.",
    },
    {
      path: "models.defaults.steps",
      type: "string-map",
      description:
        "Default model selection by internal modelStep. Values may be model profile ids, invocation profile ids, or per-model calibration slot ids.",
    },
    {
      path: "models.defaults.context",
      type: "object-map",
      description:
        "Default provider-neutral format accounting and token-estimation policy.",
    },
    {
      path: "requestRunner.configRef",
      type: "non-empty-string",
      description:
        "Path to the runtime request-runner config file, resolved relative to the runtime config file.",
    },
    {
      path: "longTermMemory.enabled",
      type: "boolean",
      defaultValue: "false",
      description:
        "Whether passive cross-session memory retrieval and collection are enabled.",
    },
    {
      path: "longTermMemory.emitClientEvents",
      type: "boolean",
      defaultValue: "false",
      description:
        "Whether bounded memory lifecycle events are visible to clients.",
    },
    {
      path: "longTermMemory.maxRecallCallsPerRequest",
      type: "positive-number",
      defaultValue: String(DEFAULT_MEMORY_RECALL_CALL_LIMIT),
      description:
        "Maximum explicit memory recall calls offered per request; must be a positive safe integer.",
    },
    {
      path: "longTermMemory.embeddingProfileId",
      type: "non-empty-string",
      description:
        "Embedding profile used by passive long-term memory when enabled.",
    },
    {
      path: "features",
      type: "feature-flag-map",
      description:
        "Legacy feature flag map. Values must be boolean, number, or string.",
    },
    {
      path: "featureFlags",
      type: "feature-flag-map",
      description:
        "Feature flag map. Values must be boolean, number, or string.",
    },
  ] as const;
