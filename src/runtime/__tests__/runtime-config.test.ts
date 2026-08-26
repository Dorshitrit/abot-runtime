import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  createRuntimeConfigJsonSchema,
  DEFAULT_RUNTIME_AGENT_BRIDGE_URL,
  loadRuntimeConfig,
  RUNTIME_CONFIG_JSON_SCHEMA,
  RUNTIME_CONFIG_SCHEMA_FIELDS,
  RuntimeConfigValidationError,
} from "../config.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";

const TEST_PROVIDER_ID = "test-provider";
const TEST_PROFILE_ID = "test-profile";

const requiredRequestRunner = {
  models: {
    providers: {
      [TEST_PROVIDER_ID]: { type: "ollama" },
    },
    profiles: {
      [TEST_PROFILE_ID]: {
        provider: TEST_PROVIDER_ID,
        model: "test:model",
        contextWindowTokens: 32_768,
      },
    },
  },
  requestRunner: {
    configRef: "./request-runner.config.json",
  },
};

function createTestRunnerConfig(profileId = TEST_PROFILE_ID) {
  return {
    models: {
      defaults: {
        profileId,
        steps: Object.fromEntries(
          REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, profileId]),
        ),
      },
    },
    context: {
      outputReserveTokens: 4_096,
      safetyReserveTokens: 1_200,
      attachmentReserveTokens: 1_024,
    },
    steps: Object.fromEntries(
      REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, { timeoutMs: 90_000 }]),
    ),
  };
}

async function writeTestRunner(
  rootDir: string,
  options: { directory?: string; profileId?: string } = {},
): Promise<void> {
  const directory = options.directory
    ? join(rootDir, options.directory)
    : rootDir;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "request-runner.config.json"),
    JSON.stringify(createTestRunnerConfig(options.profileId)),
    "utf-8",
  );
}

describe("runtime config", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("builds installable defaults from the required runtime config", async () => {
    const rootDir = "/tmp/llm-runtime-config-defaults-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(requiredRequestRunner),
      "utf-8",
    );
    await writeTestRunner(rootDir);

    const config = loadRuntimeConfig({
      env: {},
      rootDir,
    });

    expect(config.runtimeId).toBe("prod");
    expect(config.agentBridgeUrl).toBe(DEFAULT_RUNTIME_AGENT_BRIDGE_URL);
    expect(config.modelGatewayUrl).toBe("http://127.0.0.1:3000");
    expect(config.paths).toEqual({
      rootDir,
      runtimeDir: join(rootDir, ".runtime"),
      agentWorkDir: join(rootDir, "agent-work"),
      sessionsDir: join(rootDir, ".runtime", "sessions"),
      attachmentsDir: join(rootDir, ".runtime", "attachments"),
      workspaceDir: join(rootDir, "workspace"),
      sharedDir: join(rootDir, ".runtime", "shared"),
      compiledDir: join(rootDir, ".runtime", "compiled"),
      traceFile: join(rootDir, ".runtime", "logs", "runtime-debug.jsonl"),
    });
    expect(config.logging).toEqual({
      enabled: true,
      rotation: {
        maxFileSizeMb: 20,
        maxFiles: 10,
        maxAgeDays: 7,
      },
    });
    expect(config).not.toHaveProperty("tools");
    expect(config).not.toHaveProperty("skills");
    expect(config).not.toHaveProperty("webSearch");
    expect(config.requestRunner).toEqual({
      configPath: join(rootDir, "request-runner.config.json"),
    });
    expect(config).not.toHaveProperty("modes");
    expect(config).not.toHaveProperty("toolLoop");
    expect(config).not.toHaveProperty("execution");
  });
  test("resolves the runtime runner ref relative to the selected runtime config file", async () => {
    const rootDir = "/tmp/llm-runtime-runner-ref-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(join(rootDir, "config"), { recursive: true });
    await writeFile(
      join(rootDir, "config", "runtime.config.json"),
      JSON.stringify({
        ...requiredRequestRunner,
        requestRunner: {
          configRef: "./request-runner.config.json",
        },
      }),
      "utf-8",
    );
    await writeTestRunner(rootDir, { directory: "config" });

    const config = loadRuntimeConfig({
      rootDir,
      env: {},
      configPath: "config/runtime.config.json",
    });

    expect(config.requestRunner).toEqual({
      configPath: join(rootDir, "config", "request-runner.config.json"),
    });
  });

  test("rejects a runtime runner section without its config ref", async () => {
    const rootDir = "/tmp/llm-runtime-runner-ref-invalid-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({ requestRunner: {} }),
      "utf-8",
    );

    expect(() => loadRuntimeConfig({ rootDir, env: {} })).toThrow(
      "requestRunner.configRef is required",
    );
  });

  test("rejects unknown runtime runner reference fields", async () => {
    const rootDir = "/tmp/llm-runtime-runner-ref-extra-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        requestRunner: {
          configRef: "./local/request-runner.config.json",
          configPath: "/tmp/implicit-owner.json",
        },
      }),
      "utf-8",
    );

    expect(() => loadRuntimeConfig({ rootDir, env: {} })).toThrow(
      "requestRunner must contain exactly: configRef",
    );
  });

  test("accepts Web UI runtime-service startup configuration", async () => {
    const rootDir = "/tmp/llm-runtime-web-ui-config-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        ...requiredRequestRunner,
        webUi: { openOnRuntimeServiceStart: true },
      }),
      "utf-8",
    );
    await writeTestRunner(rootDir);

    expect(() => loadRuntimeConfig({ rootDir, env: {} })).not.toThrow();
  });

  test("rejects invalid Web UI runtime-service startup configuration", async () => {
    const rootDir = "/tmp/llm-runtime-web-ui-config-invalid-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        ...requiredRequestRunner,
        webUi: {
          openOnRuntimeServiceStart: "yes",
          legacyAutoOpen: true,
        },
      }),
      "utf-8",
    );
    expect(() => loadRuntimeConfig({ rootDir, env: {} })).toThrow(
      expect.objectContaining({
        issues: [
          "webUi.openOnRuntimeServiceStart must be a boolean",
          "webUi.legacyAutoOpen is not a supported configuration field",
        ],
      }),
    );
  });

  test("loads runtime.config.json between defaults and env overrides", async () => {
    const rootDir = "/tmp/llm-runtime-config-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          agentBridgeUrl: "ws://json.example/agent",
          modelGatewayUrl: "http://json-model.example",
          paths: {
            agentWorkDir: "json-sandbox",
            sessionsDir: "json-sessions",
            attachmentsDir: "json-attachments",
            sharedDir: "json-shared",
            traceFile: "json-logs/runtime.jsonl",
          },
          logging: {
            enabled: false,
            rotation: {
              maxFileSizeMb: 5,
              maxFiles: 3,
              maxAgeDays: 2,
            },
          },
          timeouts: {
            modelStepTimeoutMs: 2222,
            streamInactivityTimeoutMs: 3333,
          },
          plugins: {
            enabled: true,
            allow: ["*", "", " filesystem "],
            deny: ["filesystem.read_file", "", " filesystem.read_file "],
          },
          models: {
            providers: {
              ollama: {
                type: "ollama",
                baseUrl: "http://ollama.local",
                keepAlive: "15m",
              },
            },
            profiles: {
              "local-planner": {
                provider: "ollama",
                model: "planner:model",
                contextWindowTokens: 32_768,
              },
            },
            defaults: {
              profileId: "local-planner",
              steps: {
                "supervisor.decision": "local-planner",
              },
            },
          },
          featureFlags: {
            requestRuntime: true,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeTestRunner(rootDir, { profileId: "local-planner" });

    const config = loadRuntimeConfig({
      rootDir,
      env: {
        AGENT_BRIDGE_URL: "ws://env.example/agent",
        LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS: "4444",
        LLM_RUNTIME_TRACE: "1",
      },
    });

    expect(config.agentBridgeUrl).toBe("ws://env.example/agent");
    expect(config.modelGatewayUrl).toBe("http://json-model.example");
    expect(config.paths.sessionsDir).toBe(join(rootDir, "json-sessions"));
    expect(config.paths.agentWorkDir).toBe(join(rootDir, "json-sandbox"));
    expect(config.paths.sharedDir).toBe(join(rootDir, "json-shared"));
    expect(config.paths.traceFile).toBe(
      join(rootDir, "json-logs/runtime.jsonl"),
    );
    expect(config.logging).toEqual({
      enabled: true,
      rotation: {
        maxFileSizeMb: 5,
        maxFiles: 3,
        maxAgeDays: 2,
      },
    });
    expect(config.timeouts).toMatchObject({
      modelStepTimeoutMs: 2222,
      streamInactivityTimeoutMs: 4444,
    });
    expect(config.plugins).toEqual({
      enabled: true,
      allow: ["*", "filesystem"],
      deny: ["filesystem.read_file"],
    });
    expect(config.requestRunner).toEqual({
      configPath: join(rootDir, "request-runner.config.json"),
    });
    expect(config.models?.providers?.ollama).toEqual({
      type: "ollama",
      baseUrl: "http://ollama.local",
      keepAlive: "15m",
    });
    expect(config.featureFlags).toEqual({
      requestRuntime: true,
    });
  });
  test("loads model profile configRef relative to the runtime config file", async () => {
    const rootDir = "/tmp/llm-runtime-model-ref-config-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(join(rootDir, "models"), { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          models: {
            providers: {
              ollama: { type: "ollama" },
            },
            profiles: {
              "local-gemma": {
                configRef: "./models/local-gemma.config.json",
              },
            },
            defaults: {
              profileId: "local-gemma",
              steps: {
                "supervisor.decision": "supervisor.decision",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeTestRunner(rootDir, { profileId: "local-gemma" });
    await writeFile(
      join(rootDir, "models", "local-gemma.config.json"),
      JSON.stringify(
        {
          label: "Local Gemma",
          provider: "ollama",
          model: "gemma-local:test",
          contextWindowTokens: 32768,
          supportsThinking: true,
          generation: {
            temperature: 1,
            topP: 0.95,
          },
          context: {
            formatTokenAccounting: {
              mode: "none",
              fixedOverheadTokens: 0,
            },
            tokenEstimation: {
              asciiCharactersPerToken: 4,
              nonAsciiBytesPerToken: 2,
              messageOverheadTokens: 6,
            },
          },
          execution: {
            policy: "supervisor-worker-v1",
          },
          calibration: {
            "supervisor.decision": {
              timeoutMs: 180000,
              generation: {
                temperature: 0.15,
              },
              format: "json",
              instructions: [
                "Return compact decision JSON.",
                "Keep generated payload text out of control params.",
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const config = loadRuntimeConfig({ rootDir, env: {} });

    expect(config.models?.profiles?.["local-gemma"]).toEqual({
      configRef: "./models/local-gemma.config.json",
      label: "Local Gemma",
      provider: "ollama",
      model: "gemma-local:test",
      contextWindowTokens: 32768,
      supportsThinking: true,
      generation: {
        temperature: 1,
        topP: 0.95,
      },
      context: {
        formatTokenAccounting: {
          mode: "none",
          fixedOverheadTokens: 0,
        },
        tokenEstimation: {
          asciiCharactersPerToken: 4,
          nonAsciiBytesPerToken: 2,
          messageOverheadTokens: 6,
        },
      },
      calibration: {
        "supervisor.decision": {
          timeoutMs: 180000,
          generation: {
            temperature: 0.15,
          },
          format: "json",
          instructions: [
            "Return compact decision JSON.",
            "Keep generated payload text out of control params.",
          ],
        },
      },
    });
    expect(config.models?.profiles?.["local-gemma"]).not.toHaveProperty(
      "execution",
    );
    expect(config.modelExecutionPolicies).toEqual({
      "local-gemma": {
        policy: "supervisor-worker-v1",
      },
    });
  });

  test("extracts an inline opt-in execution policy and defaults an empty execution object", async () => {
    const rootDir = "/tmp/llm-runtime-empty-model-execution-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        ...requiredRequestRunner,
        models: {
          providers: {
            local: { type: "ollama" },
          },
          profiles: {
            local: {
              provider: "local",
              model: "local:test",
              contextWindowTokens: 32_768,
              execution: {},
            },
            explicit: {
              provider: "local",
              model: "explicit:test",
              contextWindowTokens: 32_768,
              execution: { policy: "execution-agent-v1" },
            },
          },
          defaults: { profileId: "local" },
        },
      }),
      "utf-8",
    );
    await writeTestRunner(rootDir, { profileId: "local" });

    const config = loadRuntimeConfig({ rootDir, env: {} });

    expect(config.models?.profiles?.local).not.toHaveProperty("execution");
    expect(config.models?.profiles?.explicit).not.toHaveProperty("execution");
    expect(config.modelExecutionPolicies).toEqual({
      explicit: { policy: "execution-agent-v1" },
    });
  });

  test("validates referenced model profile config contents", async () => {
    const rootDir = "/tmp/llm-runtime-config-model-ref-invalid-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(join(rootDir, "models"), { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          models: {
            providers: {
              ollama: { type: "ollama" },
            },
            profiles: {
              broken: {
                configRef: "./models/broken.config.json",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(rootDir, "models", "broken.config.json"),
      JSON.stringify(
        {
          contextWindowTokens: "large",
          generation: {
            maxOutputTokens: 1024,
          },
          context: {
            maxConversationMessages: 10,
            maxToolObservationMessages: 4,
            formatTokenAccounting: {
              mode: "future",
              fixedOverheadTokens: -1,
            },
            tokenEstimation: {
              asciiCharactersPerToken: 0,
            },
            compaction: {
              pinned: {
                triggerInputTokens: 1000,
                targetInputTokens: 1000,
                disabledSteps: ["missing.step", "missing.step"],
              },
            },
          },
          execution: {
            policy: "direct-v1",
            retryWithSupervisor: true,
          },
          calibration: {
            "toolPayload.raw": {
              timeoutMs: 1.5,
              context: {
                artifactContextMode: "canonical",
                formatTokenAccounting: {
                  mode: "estimate",
                  fixedOverheadTokens: 1.5,
                },
                compaction: {
                  pinned: {
                    triggerInputTokens: 900,
                    targetInputTokens: 800,
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    let thrown: unknown;
    try {
      loadRuntimeConfig({ rootDir, env: {} });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeConfigValidationError);
    expect((thrown as RuntimeConfigValidationError).issues).toEqual(
      expect.arrayContaining([
        "model profile.model must be provided",
        "model profile.generation.maxOutputTokens is not supported; remove it and let the provider enforce physical output capacity",
        "model profile.contextWindowTokens must be a positive integer",
        "model profile.context.maxConversationMessages is not supported; current-session history is managed by runtime session memory",
        "model profile.context.maxToolObservationMessages is not supported; tool observations are projected by their owning context contract",
        "model profile.context.formatTokenAccounting.mode must be none or estimate",
        "model profile.context.formatTokenAccounting.fixedOverheadTokens must be a non-negative integer",
        "model profile.context.tokenEstimation.asciiCharactersPerToken must be a positive number",
        "model profile.context.compaction is not supported; context compaction uses the runtime-owned 70 percent trigger",
        "model profile.execution may contain only: policy",
        "model profile.execution.policy must be one of: supervisor-worker-v1, execution-agent-v1",
        "model profile.calibration.toolPayload.raw.timeoutMs must be a positive integer",
        "model profile.calibration.toolPayload.raw.context.artifactContextMode is not supported; artifact projection is owned by the capability context contract",
        "model profile.calibration.toolPayload.raw.context.formatTokenAccounting.fixedOverheadTokens must be a non-negative integer",
        "model profile.calibration.toolPayload.raw.context.compaction is not supported; context compaction uses the runtime-owned 70 percent trigger",
      ]),
    );
  });

  test("can load a local ignored config file selected by env", async () => {
    const rootDir = "/tmp/llm-runtime-config-local-file-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(join(rootDir, "local"), { recursive: true });
    await writeFile(
      join(rootDir, "local/runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          modelGatewayUrl: "http://local-config.example",
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeTestRunner(rootDir, { directory: "local" });

    const config = loadRuntimeConfig({
      rootDir,
      env: {
        LLM_RUNTIME_CONFIG_FILE: "local/runtime.config.json",
      },
    });

    expect(config.modelGatewayUrl).toBe("http://local-config.example");
  });

  test("prefers explicit env values over configured defaults", async () => {
    const rootDir = "/tmp/llm-runtime-config-env-override-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(requiredRequestRunner),
      "utf-8",
    );
    await writeTestRunner(rootDir);

    const config = loadRuntimeConfig({
      rootDir,
      env: {
        AGENT_BRIDGE_URL: "ws://bridge.example/agent",
        AGENT_BRIDGE_TOKEN: "secret",
        MODEL_GATEWAY_URL: "http://model.example",
        LLM_RUNTIME_SESSIONS_DIR: "/data/sessions",
        LLM_RUNTIME_ATTACHMENTS_DIR: "/data/attachments",
        LLM_RUNTIME_AGENT_WORK_DIR: "/data/sandbox",
        LLM_RUNTIME_SHARED_DIR: "/data/shared",
        LLM_RUNTIME_TRACE_FILE: "/data/logs/runtime.jsonl",
        LLM_RUNTIME_TRACE: "0",
        LLM_RUNTIME_REQUEST_TIMEOUT_MS: "1200",
        LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS: "3400",
      },
    });

    expect(config.agentBridgeUrl).toBe("ws://bridge.example/agent");
    expect(config.agentBridgeToken).toBe("secret");
    expect(config.modelGatewayUrl).toBe("http://model.example");
    expect(config.paths.sessionsDir).toBe("/data/sessions");
    expect(config.paths.attachmentsDir).toBe("/data/attachments");
    expect(config.paths.agentWorkDir).toBe("/data/sandbox");
    expect(config.paths.sharedDir).toBe("/data/shared");
    expect(config.paths.traceFile).toBe("/data/logs/runtime.jsonl");
    expect(config.logging?.enabled).toBe(false);
    expect(config.timeouts).toMatchObject({
      requestTimeoutMs: 1200,
      streamInactivityTimeoutMs: 3400,
    });
    expect(config).not.toHaveProperty("tools");
    expect(config).not.toHaveProperty("skills");
    expect(config).not.toHaveProperty("webSearch");
  });
  test("resolves environment profiles as isolated runtime data roots", async () => {
    const rootDir = "/tmp/llm-runtime-config-profile-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          environment: {
            default: "prod",
            paths: {
              runtimeDir: ".runtime/base",
              sessionsDir: ".runtime/base/sessions",
              sharedDir: ".runtime/shared",
              compiledDir: ".runtime/base/compiled",
              traceFile: ".runtime/base/logs/runtime-debug.jsonl",
              workspaceDir: "workspace",
            },
            profiles: {
              prod: {
                paths: {
                  runtimeDir: ".runtime/prod",
                  agentWorkDir: ".runtime/prod/sandbox",
                },
              },
              dev: {
                paths: {
                  runtimeDir: ".runtime/dev",
                  agentWorkDir: ".runtime/dev/sandbox",
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeTestRunner(rootDir);

    const prodConfig = loadRuntimeConfig({ rootDir, env: {} });
    expect(prodConfig.runtimeId).toBe("prod");
    expect(prodConfig.paths.runtimeDir).toBe(`${rootDir}/.runtime/prod`);
    expect(prodConfig.paths.agentWorkDir).toBe(
      `${rootDir}/.runtime/prod/sandbox`,
    );
    expect(prodConfig.paths.sessionsDir).toBe(
      `${rootDir}/.runtime/prod/sessions`,
    );
    expect(prodConfig.paths.attachmentsDir).toBe(
      `${rootDir}/.runtime/prod/attachments`,
    );
    expect(prodConfig.paths.compiledDir).toBe(
      `${rootDir}/.runtime/base/compiled`,
    );
    expect(prodConfig.paths.sharedDir).toBe(`${rootDir}/.runtime/shared`);
    expect(prodConfig.paths.traceFile).toBe(
      `${rootDir}/.runtime/prod/logs/runtime-debug.jsonl`,
    );

    const devConfig = loadRuntimeConfig({
      rootDir,
      env: { LLM_RUNTIME_PROFILE: "dev" },
    });
    expect(devConfig.runtimeId).toBe("dev");
    expect(devConfig.paths.runtimeDir).toBe(`${rootDir}/.runtime/dev`);
    expect(devConfig.paths.agentWorkDir).toBe(
      `${rootDir}/.runtime/dev/sandbox`,
    );
    expect(devConfig.paths.sessionsDir).toBe(
      `${rootDir}/.runtime/dev/sessions`,
    );
    expect(devConfig.paths.attachmentsDir).toBe(
      `${rootDir}/.runtime/dev/attachments`,
    );
    expect(devConfig.paths.compiledDir).toBe(
      `${rootDir}/.runtime/base/compiled`,
    );
    expect(devConfig.paths.sharedDir).toBe(`${rootDir}/.runtime/shared`);
    expect(devConfig.paths.traceFile).toBe(
      `${rootDir}/.runtime/dev/logs/runtime-debug.jsonl`,
    );
    expect(devConfig.paths.workspaceDir).toBe(`${rootDir}/workspace`);
  });

  test("rejects invalid runtime.config.json values with field-level issues", async () => {
    const rootDir = "/tmp/llm-runtime-config-invalid-test";
    tempDirs.push(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          paths: {
            sessionsDir: 42,
          },
          timeouts: {
            modelStepTimeoutMs: 0,
          },
          plugins: {
            enabled: "yes",
            allow: "*",
            deny: ["filesystem.read_file", 7],
          },
          models: {
            profiles: {
              broken: {
                contextWindowTokens: 32_768,
                supportsThinking: "yes",
              },
            },
          },
          features: {
            nested: { enabled: true },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    let thrown: unknown;
    try {
      loadRuntimeConfig({ rootDir, env: {} });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeConfigValidationError);
    expect(thrown).toMatchObject({
      configPath: join(rootDir, "runtime.config.json"),
      issues: expect.arrayContaining([
        "paths.sessionsDir must be a non-empty string",
        "timeouts.modelStepTimeoutMs must be a positive number",
        "plugins.enabled must be a boolean",
        "plugins.allow must be an array of strings",
        "plugins.deny must contain only strings",
        "models.profiles.broken.model or configRef must be provided",
        "models.profiles.broken.supportsThinking must be a boolean",
        "features.nested must be a boolean, number, or string",
      ]),
    });
  });
  test("exports runtime config schema metadata for docs and UI surfaces", () => {
    expect(RUNTIME_CONFIG_SCHEMA_FIELDS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "paths.runtimeDir",
          type: "non-empty-string",
          env: ["LLM_RUNTIME_DIR"],
          defaultValue: ".runtime",
        }),
        expect.objectContaining({
          path: "environment.default",
          type: "non-empty-string",
          env: ["LLM_RUNTIME_PROFILE"],
        }),
        expect.objectContaining({
          path: "webUi.openOnRuntimeServiceStart",
          type: "boolean",
          defaultValue: "false",
        }),
        expect.objectContaining({
          path: "plugins.enabled",
          type: "boolean",
          defaultValue: "true",
        }),
        expect.objectContaining({
          path: "plugins.allow",
          type: "string-array",
          defaultValue: '["*"]',
        }),
        expect.objectContaining({
          path: "plugins.deny",
          type: "string-array",
          defaultValue: "[]",
        }),
        expect.objectContaining({
          path: "models.profiles",
          type: "object-map",
        }),
        expect.objectContaining({
          path: "models.profiles.<profileId>.execution.policy",
          type: "non-empty-string",
          defaultValue: "supervisor-worker-v1",
        }),
        expect.objectContaining({
          path: "requestRunner.configRef",
          type: "non-empty-string",
        }),
        expect.objectContaining({
          path: "featureFlags",
          type: "feature-flag-map",
        }),
      ]),
    );
    expect(
      RUNTIME_CONFIG_SCHEMA_FIELDS.every((field) => field.description),
    ).toBe(true);
    expect(
      RUNTIME_CONFIG_SCHEMA_FIELDS.some((field) =>
        field.path.startsWith("modes."),
      ),
    ).toBe(false);
    expect(
      RUNTIME_CONFIG_SCHEMA_FIELDS.some(
        (field) => field.path === "toolLoop.configRef",
      ),
    ).toBe(false);
    expect(
      RUNTIME_CONFIG_SCHEMA_FIELDS.some(
        (field) => field.path === "tools.profiles",
      ),
    ).toBe(false);
    expect(
      RUNTIME_CONFIG_SCHEMA_FIELDS.some(
        (field) =>
          field.path.startsWith("tools.") ||
          field.path.startsWith("skills.") ||
          field.path.startsWith("webSearch."),
      ),
    ).toBe(false);
  });
  test("exports a runtime config JSON schema from the config metadata", () => {
    const schema = createRuntimeConfigJsonSchema();

    expect(RUNTIME_CONFIG_JSON_SCHEMA).toEqual(schema);
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "abot config",
      type: "object",
      required: ["models", "requestRunner"],
      properties: {
        paths: {
          type: "object",
        },
        environment: {
          type: "object",
        },
        webUi: {
          type: "object",
          additionalProperties: false,
          properties: {
            openOnRuntimeServiceStart: {
              type: "boolean",
              default: false,
            },
          },
        },
        plugins: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            allow: { type: "array", default: ["*"] },
            deny: { type: "array" },
          },
        },
        models: {
          type: "object",
          required: ["providers", "profiles"],
          properties: {
            providers: {
              minProperties: 1,
              propertyNames: { minLength: 1 },
            },
            profiles: {
              minProperties: 1,
              propertyNames: { minLength: 1 },
              additionalProperties: {
                properties: {
                  execution: {
                    additionalProperties: false,
                    properties: {
                      policy: {
                        type: "string",
                        enum: ["supervisor-worker-v1", "execution-agent-v1"],
                        default: "supervisor-worker-v1",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        requestRunner: {
          type: "object",
          required: ["configRef"],
          additionalProperties: false,
          properties: {
            configRef: {
              type: "string",
              minLength: 1,
            },
          },
        },
      },
    });
    expect(schema.properties).not.toHaveProperty("modes");
    expect(schema.properties).not.toHaveProperty("toolLoop");
    expect(schema.properties).not.toHaveProperty("tools");
    expect(schema.properties).not.toHaveProperty("skills");
    expect(schema.properties).not.toHaveProperty("webSearch");
  });
});
