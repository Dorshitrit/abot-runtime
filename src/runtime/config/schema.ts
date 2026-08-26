import {
  PATH_CONFIG_FIELDS,
  STRING_CONFIG_FIELDS,
  TIMEOUT_CONFIG_FIELDS,
} from "./fields.js";
import {
  DEFAULT_RUNTIME_LOGGING_ENABLED,
  DEFAULT_RUNTIME_LOG_ROTATION_CONFIG,
} from "./constants.js";
import type {
  PathConfigField,
  RuntimeConfigJsonSchema,
  StringConfigField,
  TimeoutConfigField,
} from "./types.js";
import {
  DEFAULT_REQUEST_EXECUTION_POLICY_ID,
  REQUEST_EXECUTION_POLICY_IDS,
} from "./model-execution-policy.js";

function withOptionalDefault(
  schema: Record<string, unknown>,
  defaultValue: string | undefined,
): Record<string, unknown> {
  return defaultValue === undefined
    ? schema
    : { ...schema, default: defaultValue };
}

function stringFieldSchema(field: StringConfigField): Record<string, unknown> {
  return withOptionalDefault(
    {
      type: "string",
      minLength: 1,
      description: field.description,
      "x-env": field.env,
    },
    field.defaultValue,
  );
}

function pathFieldSchema(field: PathConfigField): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    default: field.defaultValue,
    description: field.description,
    "x-env": field.env,
  };
}

function pathsSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: Object.fromEntries(
      PATH_CONFIG_FIELDS.map((field) => [field.key, pathFieldSchema(field)]),
    ),
  };
}

function timeoutFieldSchema(
  field: TimeoutConfigField,
): Record<string, unknown> {
  return {
    type: "number",
    exclusiveMinimum: 0,
    description: field.description,
    "x-env": [field.env],
  };
}

function featureFlagMapSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    additionalProperties: {
      anyOf: [{ type: "boolean" }, { type: "number" }, { type: "string" }],
    },
  };
}

function stringArraySchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    default: [],
    description,
    items: { type: "string" },
  };
}

function stringMapSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    additionalProperties: {
      type: "string",
      minLength: 1,
    },
  };
}

function modelGenerationSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "Generation settings for a model profile.",
    properties: {
      temperature: {
        type: "number",
        description: "Sampling temperature forwarded to the model provider.",
      },
      topP: {
        type: "number",
        description: "Nucleus sampling value forwarded to the model provider.",
      },
      reasoningEffort: {
        type: "string",
        enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
        description:
          "Default reasoning effort for providers/models that support it.",
      },
    },
  };
}

function modelContextSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "Context projection and token-estimation policy.",
    properties: {
      formatTokenAccounting: {
        type: "object",
        description:
          "Provider-neutral accounting for structured-response format tokens. Defaults to estimate mode with zero fixed overhead.",
        properties: {
          mode: {
            type: "string",
            enum: ["none", "estimate"],
          },
          fixedOverheadTokens: {
            type: "integer",
            minimum: 0,
          },
        },
        required: ["mode"],
      },
      tokenEstimation: {
        type: "object",
        description:
          "Model-specific input token estimation used for pre-invocation context budgeting.",
        properties: {
          asciiCharactersPerToken: {
            type: "number",
            exclusiveMinimum: 0,
          },
          nonAsciiBytesPerToken: {
            type: "number",
            exclusiveMinimum: 0,
          },
          messageOverheadTokens: {
            type: "number",
            exclusiveMinimum: 0,
          },
        },
      },
    },
  };
}

function modelGatewayFormatSchema(): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: "string",
        enum: ["json"],
      },
      {
        type: "object",
        additionalProperties: true,
      },
    ],
    description:
      "Optional provider response format override for this invocation profile.",
  };
}

function modelInvocationProfilesSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Invocation profiles keyed by id. They reference a model profile and override per-invocation generation, context, or format policy.",
    additionalProperties: {
      type: "object",
      properties: {
        profileId: {
          type: "string",
          minLength: 1,
          description:
            "Model profile id used as the provider/model base for this invocation profile.",
        },
        generation: modelGenerationSchema(),
        context: modelContextSchema(),
        format: modelGatewayFormatSchema(),
      },
      required: ["profileId"],
    },
  };
}

function modelCalibrationSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Per-model calibration slots keyed by semantic slot id. Runtime step config can map internal modelStep names to these slots without naming a concrete model.",
    additionalProperties: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description:
            "Human-readable display name for this model calibration slot.",
        },
        description: {
          type: "string",
          minLength: 1,
          description:
            "Short UI description explaining when this calibration slot is used.",
        },
        profileId: {
          type: "string",
          minLength: 1,
          description:
            "Optional model profile id override for this slot. When omitted, the selected/requested model profile remains the base.",
        },
        timeoutMs: {
          type: "integer",
          exclusiveMinimum: 0,
          description:
            "Optional runtime timeout override for this model and semantic step.",
        },
        generation: modelGenerationSchema(),
        context: modelContextSchema(),
        format: modelGatewayFormatSchema(),
        instructions: stringArraySchema(
          "Short calibration-only instructions injected for this model when runtime step config maps a modelStep to this semantic slot.",
        ),
      },
    },
  };
}

function rootRequestRunnerSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "runtime request-runner configuration reference.",
    properties: {
      configRef: {
        type: "string",
        minLength: 1,
        description:
          "Path to the runtime request-runner config file, resolved relative to the runtime config file.",
      },
    },
    required: ["configRef"],
    additionalProperties: false,
  };
}

function pluginsSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Installed runtime plugin selection. Plugin manifests own capability and skill declarations.",
    properties: {
      enabled: {
        type: "boolean",
        default: true,
        description: "Whether installed runtime plugins are allowed to load.",
      },
      allow: {
        ...stringArraySchema(
          "Optional allow-list of installed plugin or capability ids. The wildcard enables every installed plugin.",
        ),
        default: ["*"],
      },
      deny: stringArraySchema(
        "Installed plugin or capability ids denied after applying the allow-list.",
      ),
    },
    additionalProperties: false,
  };
}

export function createRuntimeConfigJsonSchema(): RuntimeConfigJsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://abot.local/runtime.config.schema.json",
    title: "abot config",
    type: "object",
    required: ["models", "requestRunner"],
    properties: {
      ...Object.fromEntries(
        STRING_CONFIG_FIELDS.map((field) => [
          field.path,
          stringFieldSchema(field),
        ]),
      ),
      environment: {
        type: "object",
        description:
          "Optional named runtime environment profiles used to isolate runtime data roots while reusing the same runtime code and shared source directories.",
        properties: {
          default: {
            type: "string",
            minLength: 1,
            description:
              "Default environment profile id used when no explicit runtime profile override is provided.",
            "x-env": ["LLM_RUNTIME_PROFILE"],
          },
          paths: pathsSchema(
            "Base filesystem paths used by default runtime adapters before profile-specific environment overrides are applied.",
          ),
          profiles: {
            type: "object",
            description:
              "Named environment profiles keyed by profile id. Each profile can override filesystem paths for that data environment.",
            additionalProperties: {
              type: "object",
              properties: {
                paths: pathsSchema(
                  "Filesystem path overrides applied when this runtime environment profile is active.",
                ),
              },
            },
          },
        },
      },
      webUi: {
        type: "object",
        description: "Local Web UI startup behavior.",
        properties: {
          openOnRuntimeServiceStart: {
            type: "boolean",
            default: false,
            description:
              "Whether the local Web UI should open automatically when the Runtime service starts.",
          },
        },
        additionalProperties: false,
      },
      paths: pathsSchema("Filesystem paths used by default runtime adapters."),
      timeouts: {
        type: "object",
        description: "Runtime timeout values in milliseconds.",
        properties: Object.fromEntries(
          TIMEOUT_CONFIG_FIELDS.map((field) => [
            field.key,
            timeoutFieldSchema(field),
          ]),
        ),
      },
      logging: {
        type: "object",
        description:
          "Runtime observability settings for the active JSONL trace file and its rotated siblings.",
        properties: {
          enabled: {
            type: "boolean",
            default: DEFAULT_RUNTIME_LOGGING_ENABLED,
            description:
              "Whether runtime observability writes the active JSONL trace file.",
          },
          rotation: {
            type: "object",
            description:
              "Retention policy applied to the active JSONL trace file during writes.",
            properties: {
              maxFileSizeMb: {
                type: "number",
                exclusiveMinimum: 0,
                default: DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxFileSizeMb,
                description:
                  "Rotate the active JSONL trace file when it reaches this size in megabytes.",
              },
              maxFiles: {
                type: "number",
                exclusiveMinimum: 0,
                default: DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxFiles,
                description:
                  "Maximum number of rotated JSONL trace siblings retained beside the active file.",
              },
              maxAgeDays: {
                type: "number",
                exclusiveMinimum: 0,
                default: DEFAULT_RUNTIME_LOG_ROTATION_CONFIG.maxAgeDays,
                description:
                  "Maximum age in days for rotated JSONL trace siblings before cleanup removes them.",
              },
            },
          },
        },
      },
      plugins: pluginsSchema(),
      models: {
        type: "object",
        description:
          "Model profiles and defaults consumed by model-gateway policy.",
        properties: {
          providers: {
            type: "object",
            minProperties: 1,
            propertyNames: { minLength: 1 },
            description:
              "Model provider declarations keyed by provider id. Profiles reference these ids.",
            additionalProperties: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  minLength: 1,
                  pattern: "^[A-Za-z][A-Za-z0-9._-]*$",
                  description:
                    "Registered model-gateway provider adapter identifier.",
                },
                baseUrl: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Optional provider base URL override. OpenAI defaults to https://api.openai.com/v1.",
                },
                apiKeyEnv: {
                  type: "string",
                  minLength: 1,
                  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
                  description:
                    "Environment variable name containing this provider API key.",
                },
                keepAlive: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Ollama model residency duration passed as keep_alive.",
                },
                settings: {
                  type: "object",
                  description:
                    "Provider-owned JSON settings interpreted by its adapter.",
                  additionalProperties: true,
                },
              },
              required: ["type"],
            },
          },
          profiles: {
            type: "object",
            minProperties: 1,
            propertyNames: { minLength: 1 },
            description: "Host-defined model profiles keyed by profile id.",
            additionalProperties: {
              type: "object",
              properties: {
                configRef: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Optional path to a model profile config file, resolved relative to the runtime config file.",
                },
                label: { type: "string", minLength: 1 },
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                contextWindowTokens: {
                  type: "integer",
                  exclusiveMinimum: 0,
                  description:
                    "Declared physical context-window capacity. Required for every materialized model profile unless the provider supplies reliable discovery metadata.",
                },
                supportsThinking: { type: "boolean" },
                capabilities: {
                  type: "object",
                  properties: {
                    inputModalities: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: ["text", "image", "audio"],
                      },
                    },
                    outputModalities: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: ["text", "image", "audio"],
                      },
                    },
                  },
                },
                options: {
                  type: "object",
                  additionalProperties: true,
                },
                generation: modelGenerationSchema(),
                context: modelContextSchema(),
                execution: {
                  type: "object",
                  description:
                    "Runtime-only request execution policy for this model profile. Omission selects supervisor-worker-v1; execution-agent-v1 is an explicit per-profile opt-in. This metadata is not forwarded to the model gateway.",
                  properties: {
                    policy: {
                      type: "string",
                      enum: [...REQUEST_EXECUTION_POLICY_IDS],
                      default: DEFAULT_REQUEST_EXECUTION_POLICY_ID,
                    },
                  },
                  additionalProperties: false,
                },
                calibration: modelCalibrationSchema(),
              },
              anyOf: [
                {
                  required: ["model", "provider", "contextWindowTokens"],
                },
                { required: ["configRef"] },
              ],
            },
          },
          invocationProfiles: modelInvocationProfilesSchema(),
          defaults: {
            type: "object",
            description: "Default model profile ids by runtime selection key.",
            properties: {
              overrideClientPreference: {
                type: "boolean",
                default: false,
                description:
                  "Whether runtime model selection ignores the client model preference and relies on configured defaults, roles, and steps.",
              },
              profileId: {
                type: "string",
                minLength: 1,
                description:
                  "Default model profile id for ordinary runtime model calls.",
              },
              roles: stringMapSchema(
                "Default model profile ids by runtime role.",
              ),
              steps: stringMapSchema(
                "Default model selection by internal modelStep. Values may be legacy model profile ids, legacy invocation profile ids, or per-model calibration slot ids.",
              ),
              context: modelContextSchema(),
            },
          },
        },
        required: ["providers", "profiles"],
      },
      requestRunner: rootRequestRunnerSchema(),
      features: featureFlagMapSchema(
        "Legacy feature flag map. Values must be boolean, number, or string.",
      ),
      featureFlags: featureFlagMapSchema(
        "Feature flag map. Values must be boolean, number, or string.",
      ),
    },
  };
}

export const RUNTIME_CONFIG_JSON_SCHEMA = createRuntimeConfigJsonSchema();
