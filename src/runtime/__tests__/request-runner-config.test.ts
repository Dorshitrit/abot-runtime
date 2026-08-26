import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { MODEL_INVOCATION_STEP_DEFINITIONS } from "../../shared/model-step-registry.js";
import {
  REQUEST_INVOKED_STEP_IDS,
  type RequestRunnerConfig,
} from "../config/runner/contracts.js";
import { loadRequestRunnerConfig as loadRequestRunnerConfigAtPath } from "../config/runner/loader.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";

const temporaryRoots: string[] = [];

type RunnerConfigFixture = {
  models: {
    defaults: {
      profileId: string;
      steps: Record<string, string>;
    };
  };
  context?: Record<string, unknown>;
  steps: Record<
    string,
    { timeoutMs: number; instructionRefs?: readonly string[] }
  >;
};

function runnerConfigPath(rootDir: string): string {
  return join(rootDir, "local", "request-runner.config.json");
}

function loadRequestRunnerConfig(params: { rootDir: string }) {
  return loadRequestRunnerConfigAtPath({
    configPath: runnerConfigPath(params.rootDir),
  });
}

function createConfigRoot(config: unknown): string {
  const rootDir = mkdtempSync(join(tmpdir(), "request-runner-config-"));
  temporaryRoots.push(rootDir);
  mkdirSync(join(rootDir, "local"), { recursive: true });
  writeFileSync(runnerConfigPath(rootDir), JSON.stringify(config));
  return rootDir;
}

function createStepMappings(): Record<string, string> {
  return Object.fromEntries(
    REQUEST_INVOKED_STEP_IDS.map((stepId) => [
      stepId,
      stepId === "supervisor.decision" ? "supervisorDecision" : stepId,
    ]),
  );
}

function createStepConfigs(): Record<
  string,
  { timeoutMs: number; instructionRefs?: readonly string[] }
> {
  return Object.fromEntries(
    REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, { timeoutMs: 20_000 }]),
  );
}

function createContextConfig(): Record<string, unknown> {
  return {
    outputReserveTokens: 4_096,
    safetyReserveTokens: 1_200,
    attachmentReserveTokens: 1_024,
  };
}

function createConfig(
  overrides: {
    profileId?: string;
    modelSteps?: Record<string, string>;
    context?: Record<string, unknown> | null;
    steps?: Record<string, { timeoutMs: number }>;
  } = {},
): RunnerConfigFixture {
  return {
    models: {
      defaults: {
        profileId: overrides.profileId ?? "gemma-e4b",
        steps: overrides.modelSteps ?? createStepMappings(),
      },
    },
    ...(overrides.context === null
      ? {}
      : { context: overrides.context ?? createContextConfig() }),
    steps: overrides.steps ?? createStepConfigs(),
  };
}

function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("request runner config", () => {
  test("derives the invoked-step set from the shared registry", () => {
    expect(REQUEST_INVOKED_STEP_IDS).toEqual(
      MODEL_INVOCATION_STEP_DEFINITIONS.map((definition) => definition.id),
    );
  });

  test("requires an absolute path resolved by runtime config", () => {
    expect(() =>
      loadRequestRunnerConfigAtPath({
        configPath: "local/request-runner.config.json",
      }),
    ).toThrow(
      "runtime request runner configPath must be an absolute path resolved from runtime config",
    );
  });

  test("loads the union of Supervisor-led and Execution Agent step configuration", () => {
    const loaded = loadRequestRunnerConfig({
      rootDir: createConfigRoot(createConfig()),
    });

    expect(loaded.models.defaults.steps).toEqual(createStepMappings());
    expect(loaded.context).toEqual(createContextConfig());
    expect(Object.keys(loaded.steps)).toEqual([...REQUEST_INVOKED_STEP_IDS]);
    expect(loaded).not.toHaveProperty("profiles");
  });

  test("loads the packaged request-runner config template through the strict loader", () => {
    const loaded = loadRequestRunnerConfigAtPath({
      configPath: join(
        process.cwd(),
        "examples",
        "request-runner.config.example.json",
      ),
    });

    expect(Object.keys(loaded.models.defaults.steps)).toEqual([
      ...REQUEST_INVOKED_STEP_IDS,
    ]);
    expect(Object.keys(loaded.steps)).toEqual([...REQUEST_INVOKED_STEP_IDS]);
  });

  test("deep-freezes the cached runner configuration", () => {
    const rootDir = createConfigRoot(createConfig());
    const loaded = loadRequestRunnerConfig({ rootDir });

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.models)).toBe(true);
    expect(Object.isFrozen(loaded.models.defaults.steps)).toBe(true);
    expect(Object.isFrozen(loaded.context)).toBe(true);
    expect(Object.isFrozen(loaded.steps)).toBe(true);
    expect(Object.isFrozen(loaded.steps["supervisor.decision"])).toBe(true);
    expect(loadRequestRunnerConfig({ rootDir })).toBe(loaded);
  });

  test("loads, hashes and deep-freezes relative Markdown instruction references once", () => {
    const config = createConfig();
    config.steps["supervisor.decision"] = {
      timeoutMs: 20_000,
      instructionRefs: ["./methodologies/orchestration.md"],
    };
    const rootDir = createConfigRoot(config);
    const methodologyDir = join(rootDir, "local", "methodologies");
    const methodologyPath = join(methodologyDir, "orchestration.md");
    mkdirSync(methodologyDir, { recursive: true });
    writeFileSync(methodologyPath, "  # Delegation\n\nPreserve outcomes.  ");

    const loaded = loadRequestRunnerConfig({ rootDir });
    const blocks = loaded.steps["supervisor.decision"]?.instructionBlocks ?? [];

    expect(blocks).toEqual([
      {
        ref: "./methodologies/orchestration.md",
        content: "# Delegation\n\nPreserve outcomes.",
        contentHash:
          "592e0b612b0028f52072a61dd801cc642e5cbe71dee7f0d72bd26b9cb71c53c0",
      },
    ]);
    expect(Object.isFrozen(blocks)).toBe(true);
    expect(Object.isFrozen(blocks[0])).toBe(true);

    writeFileSync(methodologyPath, "# Changed after cached load");
    expect(loadRequestRunnerConfig({ rootDir })).toBe(loaded);
    expect(
      loaded.steps["supervisor.decision"]?.instructionBlocks?.[0]?.content,
    ).toBe("# Delegation\n\nPreserve outcomes.");
  });

  test.each([
    {
      label: "empty reference list",
      refs: [],
      prepare: (_rootDir: string) => {},
      expected: "must contain between 1 and 8 unique Markdown references",
    },
    {
      label: "non-Markdown reference",
      refs: ["./methodologies/orchestration.txt"],
      prepare: (_rootDir: string) => {},
      expected: "must reference a Markdown file",
    },
    {
      label: "missing Markdown file",
      refs: ["./methodologies/missing.md"],
      prepare: (_rootDir: string) => {},
      expected: "Unable to read runtime step instructions",
    },
    {
      label: "empty Markdown file",
      refs: ["./methodologies/empty.md"],
      prepare: (rootDir: string) => {
        const target = join(rootDir, "local", "methodologies", "empty.md");
        mkdirSync(join(rootDir, "local", "methodologies"), {
          recursive: true,
        });
        writeFileSync(target, "   ");
      },
      expected: "content must contain between 1 and 32000 characters",
    },
  ])(
    "rejects $label in step instruction references",
    ({ refs, prepare, expected }) => {
      const config = createConfig();
      config.steps["supervisor.decision"] = {
        timeoutMs: 20_000,
        instructionRefs: refs,
      };
      const rootDir = createConfigRoot(config);
      prepare(rootDir);

      expect(() => loadRequestRunnerConfig({ rootDir })).toThrow(expected);
    },
  );

  test("reports unreadable and invalid JSON runner files at the owning path", () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "request-runner-missing-"));
    temporaryRoots.push(missingRoot);

    expect(() => loadRequestRunnerConfig({ rootDir: missingRoot })).toThrow(
      "Unable to read runtime request runner config",
    );

    const invalidRoot = createConfigRoot(createConfig());
    writeFileSync(runnerConfigPath(invalidRoot), "{invalid");
    expect(() => loadRequestRunnerConfig({ rootDir: invalidRoot })).toThrow(
      "Invalid runtime request runner config JSON",
    );
  });

  test("rejects the removed work-profile config surface", () => {
    const config = Object.assign(createConfig(), {
      profiles: {
        development: {},
        general: {},
      },
    });

    expect(() =>
      loadRequestRunnerConfig({
        rootDir: createConfigRoot(config),
      }),
    ).toThrow("root must contain exactly: models, context, steps");
  });

  test.each([
    {
      label: "models",
      mutate: (config: RunnerConfigFixture) => {
        Object.assign(config.models, { legacyDefaults: {} });
      },
      expected: "models must contain exactly: defaults",
    },
    {
      label: "model defaults",
      mutate: (config: RunnerConfigFixture) => {
        Object.assign(config.models.defaults, { legacyRole: "worker" });
      },
      expected: "models.defaults must contain exactly: profileId, steps",
    },
    {
      label: "model step mappings",
      mutate: (config: RunnerConfigFixture) => {
        Object.assign(config.models.defaults.steps, {
          "development.planner": "development.planner",
        });
      },
      expected: `models.defaults.steps must contain exactly: ${REQUEST_INVOKED_STEP_IDS.join(", ")}`,
    },
    {
      label: "shared context",
      mutate: (config: RunnerConfigFixture) => {
        Object.assign(config.context!, { legacyReserveTokens: 10 });
      },
      expected:
        "context must contain exactly: outputReserveTokens, safetyReserveTokens, attachmentReserveTokens",
    },
    {
      label: "step map",
      mutate: (config: RunnerConfigFixture) => {
        Object.assign(config.steps, {
          "general.worker": { timeoutMs: 20_000 },
        });
      },
      expected: `steps must contain exactly: ${REQUEST_INVOKED_STEP_IDS.join(", ")}`,
    },
    {
      label: "step entry",
      mutate: (config: RunnerConfigFixture) => {
        Object.assign(config.steps["worker.decision"]!, { retries: 1 });
      },
      expected: "steps.worker.decision must contain exactly: timeoutMs",
    },
  ])(
    "rejects unknown nested runner fields in $label",
    ({ mutate, expected }) => {
      const config = createConfig();
      mutate(config);

      expect(() =>
        loadRequestRunnerConfig({ rootDir: createConfigRoot(config) }),
      ).toThrow(expected);
    },
  );

  test.each(REQUEST_INVOKED_STEP_IDS)(
    "rejects model step %s without its own mapping",
    (stepId) => {
      const modelSteps = withoutKey(createStepMappings(), stepId);

      expect(() =>
        loadRequestRunnerConfig({
          rootDir: createConfigRoot(createConfig({ modelSteps })),
        }),
      ).toThrow(
        `models.defaults.steps.${stepId} must select a model profile or calibration slot`,
      );
    },
  );

  test.each(REQUEST_INVOKED_STEP_IDS)(
    "rejects a config without required step %s",
    (stepId) => {
      const steps = withoutKey(createStepConfigs(), stepId);

      expect(() =>
        loadRequestRunnerConfig({
          rootDir: createConfigRoot(createConfig({ steps })),
        }),
      ).toThrow(`steps.${stepId} is required`);
    },
  );

  test("rejects a blank default model profile", () => {
    expect(() =>
      loadRequestRunnerConfig({
        rootDir: createConfigRoot(createConfig({ profileId: "" })),
      }),
    ).toThrow("models.defaults.profileId must be a string");
  });

  test("rejects a config without shared context configuration", () => {
    expect(() =>
      loadRequestRunnerConfig({
        rootDir: createConfigRoot(createConfig({ context: null })),
      }),
    ).toThrow("context must be an object");
  });

  test.each([
    ["outputReserveTokens", 0],
    ["safetyReserveTokens", -1],
    ["attachmentReserveTokens", 1.5],
  ] as const)("rejects invalid positive context field %s", (field, value) => {
    expect(() =>
      loadRequestRunnerConfig({
        rootDir: createConfigRoot(
          createConfig({
            context: { ...createContextConfig(), [field]: value },
          }),
        ),
      }),
    ).toThrow(`context.${field} must be a positive integer`);
  });

  test.each(REQUEST_INVOKED_STEP_IDS)(
    "rejects invalid timeout for step %s",
    (stepId) => {
      const steps = createStepConfigs();
      steps[stepId] = { timeoutMs: 0 };

      expect(() =>
        loadRequestRunnerConfig({
          rootDir: createConfigRoot(createConfig({ steps })),
        }),
      ).toThrow(`steps.${stepId}.timeoutMs must be a positive integer`);
    },
  );

  test("uses runner-owned generic step mappings in the model policy", () => {
    const runnerConfig = loadRequestRunnerConfig({
      rootDir: createConfigRoot(createConfig({ profileId: "runtime-model" })),
    });

    const modelPolicy = createRequestModelPolicy({
      platformPolicy: {
        providers: {
          local: { type: "ollama", baseUrl: "http://configured:11434" },
        },
        profiles: {
          "runtime-model": {
            provider: "local",
            model: "runtime-model:latest",
            contextWindowTokens: 64_000,
            supportsThinking: true,
            calibration: {
              supervisorDecision: {
                generation: {
                  temperature: 0.05,
                },
              },
            },
          },
        },
        defaults: {
          profileId: "platform-model",
          overrideClientPreference: true,
          steps: {
            "unrelated.step": "unusedCalibration",
          },
        },
      },
      runnerConfig,
    });

    expect(modelPolicy.providers).toEqual({
      local: { type: "ollama", baseUrl: "http://configured:11434" },
    });
    expect(modelPolicy.defaults).toEqual({
      profileId: "runtime-model",
      overrideClientPreference: true,
      steps: createStepMappings(),
    });

    const supervisorInvocation = resolveModelInvocation({
      agentMode: "reasoning",
      modelStep: "supervisor.decision",
      modelPolicy,
    });
    expect(supervisorInvocation.profile).toMatchObject({
      id: "runtime-model",
      providerId: "local",
      providerConfig: {
        type: "ollama",
        baseUrl: "http://configured:11434",
      },
      generation: {
        temperature: 0.05,
      },
    });

    const reviewerInvocation = resolveModelInvocation({
      agentMode: "reasoning",
      modelStep: "reviewer.decision",
      modelPolicy,
    });
    expect(reviewerInvocation.profile.id).toBe("runtime-model");
    expect(reviewerInvocation.profile.generation.temperature).not.toBe(0.05);
  });

  test("accepts a fully parsed config as the public runner contract", () => {
    const loaded: RequestRunnerConfig = loadRequestRunnerConfig({
      rootDir: createConfigRoot(createConfig()),
    });

    expect(loaded.models.defaults.profileId).toBe("gemma-e4b");
  });
});
