import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  REQUEST_INVOKED_STEP_IDS,
  type RequestRunnerConfig,
} from "./contracts.js";
import { loadRequestStepInstructionBlocks } from "./instruction-refs.js";
import {
  formatConfigError,
  invalidRuntimeConfig,
  deepFreezeConfig,
  requireExactConfigKeys,
  requireConfigRecord,
  requireConfigString,
  requireConfigStringMap,
  requirePositiveConfigInteger,
} from "./validation.js";

const configCache = new Map<string, RequestRunnerConfig>();

export function loadRequestRunnerConfig(params: {
  configPath: string;
}): RequestRunnerConfig {
  const configuredPath = params.configPath.trim();
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new Error(
      "runtime request runner configPath must be an absolute path resolved from runtime config",
    );
  }
  const configPath = resolve(configuredPath);
  const cached = configCache.get(configPath);
  if (cached) {
    return cached;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error: unknown) {
    throw new Error(
      `Unable to read runtime request runner config at ${configPath}: ${formatConfigError(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `Invalid runtime request runner config JSON at ${configPath}: ${formatConfigError(error)}`,
    );
  }

  const config = deepFreezeConfig(parseRequestRunnerConfig(parsed, configPath));
  configCache.set(configPath, config);
  return config;
}

function parseRequestRunnerConfig(
  value: unknown,
  configPath: string,
): RequestRunnerConfig {
  const root = requireConfigRecord(value, configPath, "root");
  const models = requireConfigRecord(root.models, configPath, "models");
  requireExactConfigKeys(models, ["defaults"], configPath, "models");
  const modelDefaults = requireConfigRecord(
    models.defaults,
    configPath,
    "models.defaults",
  );
  requireExactConfigKeys(
    modelDefaults,
    ["profileId", "steps"],
    configPath,
    "models.defaults",
  );
  const profileId = requireConfigString(
    modelDefaults.profileId,
    configPath,
    "models.defaults.profileId",
  );
  const rawModelSteps = requireConfigRecord(
    modelDefaults.steps,
    configPath,
    "models.defaults.steps",
  );
  for (const stepId of REQUEST_INVOKED_STEP_IDS) {
    if (!Object.hasOwn(rawModelSteps, stepId)) {
      throw invalidRuntimeConfig(
        configPath,
        `models.defaults.steps.${stepId} must select a model profile or calibration slot`,
      );
    }
  }
  requireExactConfigKeys(
    rawModelSteps,
    REQUEST_INVOKED_STEP_IDS,
    configPath,
    "models.defaults.steps",
  );
  const modelSteps = requireConfigStringMap(
    rawModelSteps,
    configPath,
    "models.defaults.steps",
  );
  const rawContext = requireConfigRecord(root.context, configPath, "context");
  requireExactConfigKeys(
    root,
    ["models", "context", "steps"],
    configPath,
    "root",
  );
  requireExactConfigKeys(
    rawContext,
    [
      "outputReserveTokens",
      "safetyReserveTokens",
      "attachmentReserveTokens",
    ],
    configPath,
    "context",
  );
  const context = {
    outputReserveTokens: requirePositiveConfigInteger(
      rawContext.outputReserveTokens,
      configPath,
      "context.outputReserveTokens",
    ),
    safetyReserveTokens: requirePositiveConfigInteger(
      rawContext.safetyReserveTokens,
      configPath,
      "context.safetyReserveTokens",
    ),
    attachmentReserveTokens: requirePositiveConfigInteger(
      rawContext.attachmentReserveTokens,
      configPath,
      "context.attachmentReserveTokens",
    ),
  };
  const rawSteps = requireConfigRecord(root.steps, configPath, "steps");
  for (const stepId of REQUEST_INVOKED_STEP_IDS) {
    if (!Object.hasOwn(rawSteps, stepId)) {
      throw invalidRuntimeConfig(configPath, `steps.${stepId} is required`);
    }
  }
  requireExactConfigKeys(
    rawSteps,
    REQUEST_INVOKED_STEP_IDS,
    configPath,
    "steps",
  );
  const steps = Object.fromEntries(
    REQUEST_INVOKED_STEP_IDS.map((stepId) => {
      const rawStep = rawSteps[stepId];
      const step = requireConfigRecord(rawStep, configPath, `steps.${stepId}`);
      const hasInstructionRefs = Object.hasOwn(step, "instructionRefs");
      requireExactConfigKeys(
        step,
        ["timeoutMs", ...(hasInstructionRefs ? ["instructionRefs"] : [])],
        configPath,
        `steps.${stepId}`,
      );
      return [
        stepId,
        {
          timeoutMs: requirePositiveConfigInteger(
            step.timeoutMs,
            configPath,
            `steps.${stepId}.timeoutMs`,
          ),
          ...(hasInstructionRefs
            ? {
                instructionBlocks: loadRequestStepInstructionBlocks({
                  configPath,
                  stepId,
                  rawRefs: step.instructionRefs,
                }),
              }
            : {}),
        },
      ];
    }),
  );

  return {
    models: {
      defaults: {
        profileId,
        steps: modelSteps,
      },
    },
    context,
    steps,
  };
}
